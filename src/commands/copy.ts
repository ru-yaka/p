import { basename, resolve } from "node:path";
import { intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import {
	getProjectPath,
	projectExists,
	saveProjectMeta,
	validateProjectNameFormat,
} from "../core/project";
import { execAndCapture, moveToTrash, openWithIDE } from "../utils/shell";
import { bgOrange, brand, printError } from "../utils/ui";

interface CopyTarget {
	sourcePath: string;
	projectName: string;
	targetPath: string;
}

interface CopyOptions {
	open?: boolean;
	trash?: boolean;
}

export const copyCommand = new Command("copy")
	.alias("cp")
	.description("全量复制目录作为新项目到 p 管理（支持逗号分隔多路径）")
	.argument("<paths>", "要复制的目录路径（多个用逗号分隔）")
	.argument("[names]", "自定义项目名（多个用逗号分隔，数量需与路径对应）")
	.option("-o, --open", "复制完成后用 IDE 打开项目")
	.option("--no-trash", "不移入原始目录到回收站（默认会移入）")
	.action(async (inputPaths: string, inputNames: string | undefined, options: CopyOptions) => {
		const config = loadConfig();

		// 解析逗号分隔的路径与名称
		const paths = inputPaths.split(",").map((s) => s.trim()).filter(Boolean);
		const names = inputNames
			? inputNames.split(",").map((s) => s.trim()).filter(Boolean)
			: [];

		if (names.length > 0 && names.length !== paths.length) {
			printError(
				`项目名数量 (${names.length}) 与路径数量 (${paths.length}) 不匹配`,
			);
			process.exit(1);
		}

		const isMultiple = paths.length > 1;
		const targets: CopyTarget[] = [];

		// 解析并验证每个目标
		for (let i = 0; i < paths.length; i++) {
			const sourcePath = resolve(paths[i]);

			if (!fse.existsSync(sourcePath)) {
				printError(`路径不存在: ${sourcePath}`);
				process.exit(1);
			}

			const stat = await fse.stat(sourcePath);
			if (!stat.isDirectory()) {
				printError(`不是目录: ${sourcePath}`);
				process.exit(1);
			}

			let projectName = names[i] || basename(sourcePath);

			const nameCheck = validateProjectNameFormat(projectName);
			if (!nameCheck.valid) {
				printError(nameCheck.message || `项目名称无效: ${projectName}`);
				process.exit(1);
			}

			// 冲突处理：单项目交互改名，多项目直接报错
			if (projectExists(projectName)) {
				if (isMultiple) {
					printError(`项目名 "${projectName}" 已存在`);
					process.exit(1);
				}

				intro(bgOrange(" 复制目录 "));

				const result = await text({
					message: `项目名 "${projectName}" 已存在，请输入新名称:`,
					placeholder: `${projectName}-2`,
					validate: (value) => {
						const v = validateProjectNameFormat(value);
						if (!v.valid) return v.message;
						if (projectExists(value)) return "项目已存在";
						return undefined;
					},
				});

				if (isCancel(result)) {
					outro(pc.dim("已取消"));
					process.exit(0);
				}

				projectName = (result as string).trim();
			}

			targets.push({
				sourcePath,
				projectName,
				targetPath: getProjectPath(projectName),
			});
		}

		intro(
			isMultiple
				? bgOrange(` 复制 ${targets.length} 个项目 `)
				: bgOrange(" 复制目录 "),
		);

		// 显示信息
		for (const t of targets) {
			console.log(pc.dim("  源路径:   ") + pc.underline(t.sourcePath));
			console.log(pc.dim("  项目名:   ") + brand.primary(t.projectName));
		}
		console.log();

		// 逐个复制
		for (const t of targets) {
			const s = spinner();
			s.start(`正在复制 ${t.projectName}...`);

			try {
				await fse.copy(t.sourcePath, t.targetPath, { overwrite: true });
				s.stop(`${brand.success("✓")} ${t.projectName} 已复制`);
			} catch (error) {
				s.stop(`${t.projectName} 复制失败`);
				printError((error as Error).message);
				process.exit(1);
			}

			// 初始化 git
			const gitResult = await execAndCapture("git init", t.targetPath);
			if (!gitResult.success) {
				console.log(
					pc.dim(`  ${t.projectName} git init 失败: ${gitResult.error}`),
				);
			}

			saveProjectMeta(t.projectName, { template: "copy" });
		}

		// 打开 IDE（如指定）
		if (options.open) {
			for (const t of targets) {
				const ideSpinner = spinner();
				ideSpinner.start(`正在用 ${config.ide} 打开 ${t.projectName}...`);

				try {
					await openWithIDE(config.ide, t.targetPath);
					ideSpinner.stop(
						`${brand.success("✓")} 已打开: ${brand.primary(t.projectName)}`,
					);
				} catch (error) {
					ideSpinner.stop(`打开 ${config.ide} 失败`);
					console.log();
					printError((error as Error).message);
					console.log();
					console.log(pc.dim("  项目路径: ") + pc.underline(t.targetPath));
					console.log();
				}
			}
		}

		// 回收站：默认移入，--no-trash 跳过
		const doTrash = options.trash !== false;

		if (doTrash) {
			for (const t of targets) {
				const trashSpinner = spinner();
				trashSpinner.start(`正在移入回收站 ${t.projectName}...`);

				const success = await moveToTrash(t.sourcePath);
				if (success) {
					trashSpinner.stop(
						`${brand.success("✓")} ${t.projectName} 原始目录已移入回收站`,
					);
				} else {
					trashSpinner.stop(`${t.projectName} 移入回收站失败`);
					console.log(pc.dim("  请手动删除: ") + pc.underline(t.sourcePath));
				}
			}
		}

		outro(brand.success("✨ 项目复制成功！"));
	});
