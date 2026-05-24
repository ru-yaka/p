import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { intro, isCancel, multiselect, outro, spinner } from "@clack/prompts";
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
	".vscode",
	".idea",
	"*.log",
	".DS_Store",
	"Thumbs.db",
];

const MARKER_FILE = ".p-sync.json";

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

/**
 * 扫描 Downloads 目录，查找带有 p-sync 标记的 zip 文件
 */
async function scanExportedZips(): Promise<
	{ path: string; name: string; size: string; mtime: Date }[]
> {
	const downloadDir = getDownloadDir();
	if (!(await fse.pathExists(downloadDir))) return [];

	const entries = await fse.readdir(downloadDir);
	const zips: { path: string; name: string; size: string; mtime: Date }[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".zip")) continue;
		const fullPath = join(downloadDir, entry);

		// 检查 zip 内是否有标记文件
		const check = await execAndCapture(
			`unzip -l "${fullPath}" "${MARKER_FILE}"`,
			process.cwd(),
		);
		if (!check.success) continue;

		const stat = await fse.stat(fullPath);
		const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
		zips.push({
			path: fullPath,
			name: basename(entry, ".zip"),
			size: `${sizeMB}MB`,
			mtime: stat.mtime,
		});
	}

	// 按修改时间倒序
	zips.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	return zips;
}

async function handleExport(name?: string) {
	const projects = listProjects();
	const currentDir = process.cwd();

	// 处理 "." —— 当前目录
	if (name === ".") {
		const currentProject = projects.find((p) => p.path === currentDir);
		if (!currentProject) {
			printError("当前目录不是 p 管理的项目");
			process.exit(1);
		}
		name = currentProject.name;
	}

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
		// 未指定项目名，检查是否在项目目录内
		const currentProject = projects.find((p) => p.path === currentDir);
		if (currentProject) {
			projectName = currentProject.name;
		} else {
			projectName = await searchAndSelect(projects);
		}
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

	// 删除旧的 zip
	await fse.remove(zipPath).catch(() => {});

	// 先写入标记文件到项目目录
	const markerPath = join(projectPath, MARKER_FILE);
	await fse.writeJson(markerPath, {
		projectName,
		exportedAt: new Date().toISOString(),
		version: 1,
	});

	// 构建 zip 排除参数
	const excludeArgs = SYNC_EXCLUDES.map((p) => `-x "${p}"`).join(" ");

	// 打包
	const result = await execAndCapture(
		`cd "${projectPath}" && zip -r "${zipPath}" . ${excludeArgs}`,
		projectPath,
	);

	// 删除标记文件
	await fse.remove(markerPath).catch(() => {});

	if (!result.success) {
		s.stop("打包失败");
		console.log();
		printError(result.error || "zip 命令执行失败");
		process.exit(1);
	}

	const exists = await fse.pathExists(zipPath);
	if (!exists) {
		s.stop("打包失败");
		printError("ZIP 文件未创建");
		process.exit(1);
	}

	const stat = await fse.stat(zipPath);
	const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

	s.stop(`${brand.success("✓")} 已打包: ${brand.primary(`${sizeMB}MB`)}`);

	await openInFileManager(zipPath);

	console.log();
	outro(brand.success("✨ 已在文件管理器中打开，可通过 LocalSend 发送"));
}

async function importOneZip(zipPath: string, projectName: string) {
	const projectPath = getProjectPath(projectName);

	const s = spinner();
	s.start(`正在导入 ${projectName}...`);

	await fse.ensureDir(projectPath);

	const result = await execAndCapture(
		`unzip -o "${zipPath}" -d "${projectPath}"`,
		process.cwd(),
	);

	if (!result.success) {
		s.stop(`导入 ${projectName} 失败`);
		printError(result.error || "unzip 命令执行失败");
		await fse.remove(projectPath).catch(() => {});
		return false;
	}

	// 删除标记文件
	await fse.remove(join(projectPath, MARKER_FILE)).catch(() => {});

	s.stop(`${brand.success("✓")} 已导入: ${brand.primary(projectName)}`);
	saveProjectMeta(projectName, { template: "sync" });
	return true;
}

async function handleImport(file?: string) {
	// 指定了文件路径 → 直接导入
	if (file) {
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

		const ok = await importOneZip(zipPath, projectName);

		if (ok) {
			console.log();
			outro(brand.success(`✨ 项目 ${projectName} 导入成功！`));
			console.log();
			console.log(pc.dim("  使用 ") + brand.primary("p open " + projectName) + pc.dim(" 打开项目"));
			console.log();
		}
		return;
	}

	// 未指定文件 → 扫描 Downloads 中带有标记的 zip
	intro(bgOrange(" 导入项目 "));

	const zips = await scanExportedZips();

	if (zips.length === 0) {
		printInfo("Downloads 中没有可导入的项目");
		console.log(pc.dim("  提示：先在另一台机器上运行 ") + brand.primary("p sync export") + pc.dim(" 导出项目"));
		console.log();
		return;
	}

	// 只有一个 → 直接导入
	if (zips.length === 1) {
		const zip = zips[0];
		console.log(pc.dim("  找到: ") + brand.primary(zip.name) + pc.dim(` (${zip.size})`));
		console.log();

		if (projectExists(zip.name)) {
			printError(`项目已存在: ${zip.name}`);
			console.log(pc.dim("  使用 ") + brand.primary("p open " + zip.name) + pc.dim(" 打开已有项目"));
			process.exit(1);
		}

		const ok = await importOneZip(zip.path, zip.name);

		if (ok) {
			console.log();
			outro(brand.success(`✨ 项目 ${zip.name} 导入成功！`));
			console.log();
			console.log(pc.dim("  使用 ") + brand.primary("p open " + zip.name) + pc.dim(" 打开项目"));
			console.log();
		}
		return;
	}

	// 多个 → 多选
	console.log(pc.dim(`  找到 ${zips.length} 个可导入的项目:`));
	console.log();

	// 过滤掉已存在的
	const available = zips.filter((z) => !projectExists(z.name));

	if (available.length === 0) {
		printInfo("所有项目都已存在");
		return;
	}

	const options = available.map((z) => ({
		value: z.path,
		label: z.name,
		hint: z.size,
	}));

	const result = await multiselect({
		message: "选择要导入的项目:",
		options,
		required: true,
		initialValues: available.map((z) => z.path),
	});

	if (isCancel(result)) {
		outro(pc.dim("已取消"));
		return;
	}

	console.log();

	const selected = result as string[];
	let imported = 0;

	for (const path of selected) {
		const zip = available.find((z) => z.path === path);
		if (!zip) continue;
		const ok = await importOneZip(zip.path, zip.name);
		if (ok) imported++;
	}

	console.log();
	if (imported === selected.length) {
		outro(brand.success(`✨ 已成功导入 ${imported} 个项目`));
	} else {
		outro(`${brand.success("✓")} 已导入 ${imported} 个，${selected.length - imported} 个失败`);
	}
	console.log();
}

export const syncCommand = new Command("sync")
	.description("导出/导入项目（配合 LocalSend 等工具在局域网迁移）")
	.addCommand(
		new Command("export")
			.description("导出项目为 ZIP 到 Downloads 目录")
			.argument("[name]", "项目名称、. 表示当前目录")
			.action(async (name?: string) => {
				await handleExport(name);
			}),
	)
	.addCommand(
		new Command("import")
			.description("从 ZIP 文件导入项目（自动扫描 Downloads）")
			.argument("[file]", "ZIP 文件路径（不指定则自动扫描）")
			.action(async (file?: string) => {
				await handleImport(file);
			}),
	);
