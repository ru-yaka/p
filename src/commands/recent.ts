import * as readline from "node:readline";
import { Writable } from "node:stream";
import fse from "fs-extra";
import pc from "picocolors";
import { confirm, spinner } from "@clack/prompts";
// @ts-expect-error — sisteransi is a transitive dep of @clack/prompts
import { cursor as ansiCursor } from "sisteransi";

import { deleteProjectMeta, getProjectPath, listProjects } from "../core/project";
import { openWithIDE } from "../utils/shell";
import { loadConfig } from "../core/config";
import { bgOrange, brand, formatRelativeTime, printError, printInfo } from "../utils/ui";

const MAX_VISIBLE = 10;

export const recentCommand = new Command("recent")
	.alias("re")
	.description("查看最近项目")
	.action(async () => {
		const config = loadConfig();
		const projects = listProjects();

		if (projects.length === 0) {
			console.log();
			printInfo(`暂无项目，使用 ${brand.primary("p new")} 创建新项目`);
			console.log();
			return;
		}

		const recent = projects.slice(0, config.recentCount ?? 5);

		const stdin = process.stdin as NodeJS.ReadStream;
		const stdout = process.stdout as NodeJS.WriteStream;

		const interceptStream = new Writable({
			write(_chunk, _encoding, callback) { callback(); },
		});

		stdin.setRawMode(true);
		stdin.resume();
		stdout.write(ansiCursor.hide);

		const rl = readline.createInterface({
			input: stdin,
			output: interceptStream,
			terminal: true,
		});
		readline.emitKeypressEvents(stdin, rl);

		let selectedIndex = 0;
		let scrollOffset = 0;
		let blockHeight = 0;
		let done = false;
		let currentProjects = recent;

		function render() {
			const parts: string[] = [];
			if (blockHeight > 0) parts.push(ansiCursor.up(blockHeight));

			const lines: string[] = [];

			// 标题
			lines.push(`  ${brand.secondary("◆")} 最近项目 ${pc.dim(`(${currentProjects.length})`)}`);
			lines.push(`  ${brand.secondary("│")}`);

			// 项目列表
			const visibleCount = Math.min(MAX_VISIBLE, currentProjects.length - scrollOffset);
			const visible = currentProjects.slice(scrollOffset, scrollOffset + visibleCount);

			for (let i = 0; i < visible.length; i++) {
				const idx = scrollOffset + i;
				const isSelected = idx === selectedIndex;
				const p = visible[i];
				const marker = isSelected ? brand.primary("◉") : pc.dim("○");
				const name = isSelected ? brand.bold(p.name) : p.name;

				const time = pc.dim(`  ${formatRelativeTime(p.modifiedAt)}`);
				const note = p.note ? pc.dim(` — ${p.note}`) : "";
				const tpl = p.template ? ` ${pc.cyan(`[${p.template}]`)}` : "";

				lines.push(`  ${brand.secondary("│")} ${marker} ${name}${tpl}${note}${time}`);
			}

			if (currentProjects.length > MAX_VISIBLE) {
				const remaining = currentProjects.length - scrollOffset - MAX_VISIBLE;
				if (remaining > 0) {
					lines.push(`  ${brand.secondary("│")}   ${pc.dim(`... 还有 ${remaining} 个`)}`);
				}
			}

			// 底部提示
			lines.push(`  ${brand.secondary("└")} ${pc.dim("j/k 移动 · o 打开 · d 删除 · q 退出")}`);

			for (const line of lines) {
				parts.push(line + "\x1b[K\n");
			}

			if (blockHeight > lines.length) {
				for (let i = lines.length; i < blockHeight; i++) {
					parts.push("\x1b[K\n");
				}
				parts.push(ansiCursor.up(blockHeight - lines.length));
			}

			stdout.write(parts.join(""));
			blockHeight = lines.length;
		}

		render();

		function scrollSelectedIntoView() {
			if (selectedIndex < scrollOffset) {
				scrollOffset = selectedIndex;
			} else if (selectedIndex >= scrollOffset + MAX_VISIBLE) {
				scrollOffset = selectedIndex - MAX_VISIBLE + 1;
			}
		}

		function cleanup() {
			if (done) return;
			done = true;
			stdin.removeListener("keypress", onKey);
			stdin.setRawMode(false);
			stdin.pause();
			rl.close();
			stdout.write(ansiCursor.show);
		}

		function clearBlock() {
			const parts: string[] = [];
			parts.push(ansiCursor.up(blockHeight));
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			stdout.write(parts.join(""));
		}

		async function handleOpen() {
			const project = currentProjects[selectedIndex];
			if (!project) return;

			// 清除列表，显示操作
			clearBlock();
			blockHeight = 0;

			const s = spinner();
			s.start(`正在打开 ${project.name}...`);
			try {
				await openWithIDE(config.ide, project.path);
				s.stop(`${brand.success("✓")} 已打开: ${brand.primary(project.name)}`);
			} catch (error) {
				s.stop("打开失败");
				printError((error as Error).message);
			}

			cleanup();
		}

		async function handleDelete() {
			const project = currentProjects[selectedIndex];
			if (!project) return;

			// 暂停 raw mode 进行确认
			stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("keypress", onKey);

			// 清除列表，显示确认
			clearBlock();
			blockHeight = 0;

			const shouldDelete = await confirm({
				message: `确定删除 ${brand.primary(project.name)} 吗？`,
				initialValue: false,
			});

			if (shouldDelete && !readline.isCancel(shouldDelete)) {
				const s = spinner();
				s.start(`正在删除 ${project.name}...`);
				try {
					await fse.remove(project.path);
					deleteProjectMeta(project.name);
					s.stop(`${brand.success("✓")} 已删除: ${brand.primary(project.name)}`);

					// 从列表移除
					currentProjects.splice(selectedIndex, 1);
					if (selectedIndex >= currentProjects.length) {
						selectedIndex = Math.max(0, currentProjects.length - 1);
					}
				} catch (error) {
					s.stop("删除失败");
					printError((error as Error).message);
				}
			}

			if (currentProjects.length === 0) {
				cleanup();
				console.log();
				printInfo("已无项目");
				console.log();
				return;
			}

			// 恢复 raw mode，重新渲染列表
			stdin.setRawMode(true);
			stdin.resume();
			stdin.on("keypress", onKey);
			render();
		}

		function onKey(_char: string, key: readline.Key) {
			if (done) return;

			if (key.sequence === "\x03" || key.name === "q" || key.name === "escape") {
				clearBlock();
				blockHeight = 0;
				cleanup();
				return;
			}

			switch (key.name) {
				case "up":
				case "k":
					if (selectedIndex > 0) selectedIndex--;
					scrollSelectedIntoView();
					break;
				case "down":
				case "j":
					if (selectedIndex < currentProjects.length - 1) selectedIndex++;
					scrollSelectedIntoView();
					break;
				case "o":
					handleOpen();
					return;
				case "d":
					handleDelete();
					return;
				default:
					return;
			}

			render();
		}

		stdin.on("keypress", onKey);
	});
