import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { intro, outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import {
	getProjectPath,
	listProjects,
	projectExists,
	saveProjectMeta,
} from "../core/project";
import { execAndCapture } from "../utils/shell";
import { liveSearch, CANCEL } from "../utils/live-search";
import { filterProjects, projectHint } from "../utils/project-search";
import { PROJECTS_DIR } from "../utils/paths";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

const SYNC_EXCLUDES = [
	"node_modules",
	".next",
	".nuxt",
	".output",
	"dist",
	"build",
	"coverage",
	".git",
	".vscode",
	".idea",
	"*.log",
	".DS_Store",
	"Thumbs.db",
];

async function searchAndSelect(
	projects: ReturnType<typeof listProjects>,
	initialQuery?: string,
): Promise<string> {
	const options = projects.map((p) => ({
		value: p.name,
		label: p.name,
		hint: projectHint(p),
	}));

	const result = await liveSearch({
		message: "搜索要导出的项目:",
		placeholder: "输入项目名称筛选",
		options,
		filterFn: (query: string) => {
			if (!query) return options;
			const filtered = filterProjects(projects, query);
			return filtered.map((p) => ({
				value: p.name,
				label: p.name,
				hint: projectHint(p),
			}));
		},
		initialQuery,
	});

	if (result === CANCEL) {
		outro(pc.dim("已取消"));
		process.exit(0);
	}

	return (result as string[])[0];
}

function getDownloadDir(): string {
	return resolve(homedir(), "Downloads");
}

async function openInFileManager(filePath: string): Promise<void> {
	const platform = process.platform;
	let cmd: string;
	if (platform === "darwin") {
		cmd = `open -R "${filePath}"`;
	} else if (platform === "win32") {
		cmd = `explorer /select,"${filePath}"`;
	} else {
		cmd = `xdg-open "${filePath}"`;
	}
	await execAndCapture(cmd, process.cwd());
}

async function handlePush(name?: string) {
	const projects = listProjects();

	if (projects.length === 0) {
		printInfo("暂无项目");
		return;
	}

	let projectName = name;

	if (projectName) {
		if (!projectExists(projectName)) {
			const filtered = filterProjects(projects, projectName);
			if (filtered.length === 1) {
				console.log(pc.dim("  匹配到: ") + brand.primary(filtered[0].name));
				projectName = filtered[0].name;
			} else if (filtered.length > 1) {
				console.log(pc.dim(`  匹配到 ${filtered.length} 个项目`));
				projectName = await searchAndSelect(projects, projectName);
			} else {
				printError(`项目不存在: ${projectName}`);
				process.exit(1);
			}
		}
	} else {
		projectName = await searchAndSelect(projects);
	}

	const projectPath = getProjectPath(projectName);
	const downloadDir = getDownloadDir();
	const zipPath = join(downloadDir, `${projectName}.zip`);

	intro(bgOrange(" 导出项目 "));
	console.log(pc.dim("  项目: ") + brand.primary(projectName));
	console.log(pc.dim("  输出: ") + pc.underline(zipPath));
	console.log();

	const s = spinner();
	s.start("正在打包...");

	// 构建 zip 排除参数
	const excludeArgs = SYNC_EXCLUDES.map((p) => `-x "${p}"`).join(" ");

	// 删除旧的 zip
	await fse.remove(zipPath).catch(() => {});

	// 使用 zip 命令打包（排除依赖和构建产物）
	const result = await execAndCapture(
		`cd "${projectPath}" && zip -r "${zipPath}" . ${excludeArgs}`,
		projectPath,
	);

	if (!result.success) {
		s.stop("打包失败");
		console.log();
		printError(result.error || "zip 命令执行失败");
		process.exit(1);
	}

	// 检查 zip 文件是否创建
	const exists = await fse.pathExists(zipPath);
	if (!exists) {
		s.stop("打包失败");
		printError("ZIP 文件未创建");
		process.exit(1);
	}

	const stat = await fse.stat(zipPath);
	const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

	s.stop(`${brand.success("✓")} 已打包: ${brand.primary(`${sizeMB}MB`)}`);

	// 打开文件管理器并选中文件
	await openInFileManager(zipPath);

	console.log();
	outro(brand.success("✨ 已在文件管理器中打开，可通过 LocalSend 发送"));
}

async function handlePull(file?: string) {
	if (!file) {
		printError("请指定 ZIP 文件路径");
		console.log(pc.dim("  用法: p sync pull <zip文件路径>"));
		console.log(pc.dim("  示例: p sync pull ~/Downloads/my-app.zip"));
		process.exit(1);
	}

	const zipPath = resolve(file);

	if (!(await fse.pathExists(zipPath))) {
		printError(`文件不存在: ${zipPath}`);
		process.exit(1);
	}

	if (!zipPath.endsWith(".zip")) {
		printError("请指定 .zip 文件");
		process.exit(1);
	}

	const projectName = basename(zipPath, ".zip");

	if (projectExists(projectName)) {
		printError(`项目已存在: ${projectName}`);
		console.log(pc.dim("  使用 ") + brand.primary("p open " + projectName) + pc.dim(" 打开已有项目"));
		process.exit(1);
	}

	intro(bgOrange(" 导入项目 "));
	console.log(pc.dim("  文件: ") + pc.underline(zipPath));
	console.log(pc.dim("  项目: ") + brand.primary(projectName));
	console.log();

	const s = spinner();
	s.start("正在解压...");

	const projectPath = getProjectPath(projectName);
	await fse.ensureDir(projectPath);

	const result = await execAndCapture(
		`unzip -o "${zipPath}" -d "${projectPath}"`,
		process.cwd(),
	);

	if (!result.success) {
		s.stop("解压失败");
		console.log();
		printError(result.error || "unzip 命令执行失败");
		// 清理空目录
		await fse.remove(projectPath).catch(() => {});
		process.exit(1);
	}

	s.stop(`${brand.success("✓")} 已导入`);

	saveProjectMeta(projectName, { template: "sync" });

	console.log();
	outro(brand.success(`✨ 项目 ${projectName} 导入成功！`));
	console.log();
	console.log(pc.dim("  使用 ") + brand.primary("p open " + projectName) + pc.dim(" 打开项目"));
	console.log();
}

export const syncCommand = new Command("sync")
	.description("导出/导入项目（配合 LocalSend 等工具在局域网迁移）")
	.addCommand(
		new Command("push")
			.description("导出项目为 ZIP 到 Downloads 目录")
			.argument("[name]", "项目名称或搜索关键词")
			.action(async (name?: string) => {
				await handlePush(name);
			}),
	)
	.addCommand(
		new Command("pull")
			.description("从 ZIP 文件导入项目")
			.argument("<file>", "ZIP 文件路径")
			.action(async (file?: string) => {
				await handlePull(file);
			}),
	);
