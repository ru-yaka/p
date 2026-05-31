import { homedir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { confirm, intro, isCancel, multiselect, outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import AdmZip from "adm-zip";
import fse from "fs-extra";
import pc from "picocolors";

import { loadConfig } from "../core/config";
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

const DEFAULT_SYNC_EXCLUDES = [
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

function getExcludes(): string[] {
	const config = loadConfig();
	return [...DEFAULT_SYNC_EXCLUDES, ...(config.sync?.exclude || [])];
}

const SYNC_DIR_NAME = "p-sync";

function getSyncDir(): string {
	return join(getDownloadsDir(), SYNC_DIR_NAME);
}

function getDownloadsDir(): string {
	return join(homedir(), "Downloads");
}

async function promptDeletePSync(): Promise<void> {
	const pSyncDir = join(getDownloadsDir(), "p-sync");
	const checkResult = await execAndCapture(
		`test -d "${pSyncDir}" && echo exists || echo missing`,
		process.cwd(),
	);
	if (checkResult.output.trim() !== "exists") return;

	const shouldDelete = await confirm({
		message: "是否删除 Downloads/p-sync 目录？",
		initialValue: true,
	});
	if (!isCancel(shouldDelete) && shouldDelete) {
		await execAndCapture(`rm -rf "${pSyncDir}"`, process.cwd());
		console.log(pc.dim("  已删除 Downloads/p-sync"));
	}
}

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

async function openInFileManager(targetPath: string): Promise<void> {
	const platform = process.platform;
	if (platform === "win32") {
		Bun.spawn(["explorer.exe", targetPath], { detached: true });
	} else if (platform === "darwin") {
		await execAndCapture(`open "${targetPath}"`, process.cwd());
	} else {
		await execAndCapture(`xdg-open "${targetPath}"`, process.cwd());
	}
}

/**
 * 通过 shell 命令扫描 Downloads 目录（绕过 macOS TCC 权限限制）
 * Ghostty 有 FDA，shell 子进程会继承权限
 */
async function scanDownloadsDir(): Promise<
	{ path: string; name: string; size: string; mtime: Date }[]
> {
	const downloadsDir = getDownloadsDir();

	const checkResult = await execAndCapture(
		`test -d "${downloadsDir}" && echo exists || echo missing`,
		process.cwd(),
	);
	if (!checkResult.success || checkResult.output.trim() !== "exists") return [];

	// 用 find 递归查找 .zip 文件（LocalSend 可能把文件放到子目录）
	const findResult = await execAndCapture(
		`find "${downloadsDir}" -maxdepth 2 -name "*.zip" -type f`,
		process.cwd(),
	);
	if (!findResult.success) return [];

	const entries = findResult.output.split("\n").filter((e) => e.trim());
	const zips: { path: string; name: string; size: string; mtime: Date }[] = [];

	for (const fullPath of entries) {
		// 用 shell stat 获取文件大小和修改时间
		const statResult = await execAndCapture(
			`stat -f "%z %m" "${fullPath}"`,
			process.cwd(),
		);
		if (!statResult.success) continue;

		const [sizeStr, timeStr] = statResult.output.trim().split(" ");
		const sizeBytes = Number.parseInt(sizeStr || "0", 10);
		const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);

		zips.push({
			path: fullPath,
			name: basename(fullPath, ".zip"),
			size: `${sizeMB}MB`,
			mtime: new Date(Number.parseFloat(timeStr || "0") * 1000),
		});
	}

	zips.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	return zips;
}

function shouldExclude(name: string, relPath: string, excludes: string[]): boolean {
	for (const pattern of excludes) {
		if (pattern.includes("*")) {
			const regex = new RegExp(
				`^${pattern.replace(/\*/g, ".*").replace(/\./g, "\\.")}$`,
			);
			if (regex.test(name)) return true;
		}
		if (name === pattern || relPath.includes(`/${pattern}/`)) return true;
	}
	return false;
}

async function walkFiles(
	dir: string,
	excludes: string[],
	relativePath = "",
): Promise<string[]> {
	const entries = await fse.readdir(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

		if (shouldExclude(entry.name, relPath, excludes)) continue;

		if (entry.isDirectory()) {
			const subFiles = await walkFiles(
				join(dir, entry.name),
				excludes,
				relPath,
			);
			files.push(...subFiles);
		} else {
			files.push(relPath);
		}
	}

	return files;
}

async function handleExport(name?: string) {
	const projects = listProjects();
	const currentDir = process.cwd();

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
		const currentProject = projects.find((p) => p.path === currentDir);
		if (currentProject) {
			projectName = currentProject.name;
		} else {
			projectName = await searchAndSelect(projects);
		}
	}

	const projectPath = getProjectPath(projectName);
	const syncDir = getSyncDir();
	const zipPath = join(syncDir, `${projectName}.zip`);

	intro(bgOrange(" 导出项目 "));
	console.log(pc.dim("  项目: ") + brand.primary(projectName));
	console.log(pc.dim("  输出: ") + pc.underline(zipPath));
	console.log();

	const s = spinner();
	s.start("正在打包...");

	await execAndCapture(`rm -f "${zipPath}"`, process.cwd());

	const isGit = await fse.pathExists(join(projectPath, ".git"));
	let files: string[];

	if (isGit) {
		// git 仓库：用 git ls-files 尊重 .gitignore
		const listResult = await execAndCapture(
			"git ls-files --cached --modified --others --exclude-standard",
			projectPath,
		);
		const gitFiles = listResult.success
			? listResult.output.split("\n").filter((f) => f.trim())
			: [];

		// 豁免 .env 文件（不走 .gitignore）
		const envResult = await execAndCapture(
			"git ls-files --others -- .env*",
			projectPath,
		);
		const envFiles = envResult.success
			? envResult.output.split("\n").filter((f) => f.trim() && !gitFiles.includes(f))
			: [];

		files = [...gitFiles, ...envFiles];
	} else {
		// 非 git 仓库：用排除列表遍历
		files = await walkFiles(projectPath, getExcludes());
	}

	if (files.length === 0) {
		s.stop("打包失败");
		printError("项目没有可打包的文件");
		process.exit(1);
	}

	// 用 adm-zip 打包（跨平台）
	const zip = new AdmZip();
	for (const file of files) {
		const fullPath = join(projectPath, file);
		if (await fse.pathExists(fullPath)) {
			zip.addLocalFile(fullPath, dirname(file));
		}
	}
	// 写入临时文件后 shell mv 到 Downloads（绕过 macOS TCC）
	const tmpZip = join(PROJECTS_DIR, `.tmp-export-${Date.now()}.zip`);
	zip.writeZip(tmpZip);
	await execAndCapture(`mkdir -p "${syncDir}" && mv "${tmpZip}" "${zipPath}"`, process.cwd());

	const statResult = await execAndCapture(`stat -f "%z" "${zipPath}" 2>/dev/null || stat -c "%s" "${zipPath}"`, process.cwd());
	const sizeBytes = Number.parseInt(statResult.output.trim() || "0", 10);
	const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);

	s.stop(`${brand.success("✓")} 已打包: ${brand.primary(`${sizeMB}MB`)}`);

	await openInFileManager(getSyncDir());

	console.log();
	outro(brand.success("✨ 已打开同步目录，可通过 LocalSend 发送"));
}

async function importOneZip(zipPath: string, projectName: string) {
	const projectPath = getProjectPath(projectName);

	const s = spinner();
	s.start(`正在导入 ${projectName}...`);

	await fse.ensureDir(projectPath);

	try {
		// 先通过 shell cp 复制到临时位置（绕过 macOS TCC），再解压
		const tmpZip = join(PROJECTS_DIR, `.tmp-import-${Date.now()}.zip`);
		const cpResult = await execAndCapture(
			`cp "${zipPath}" "${tmpZip}"`,
			process.cwd(),
		);
		if (!cpResult.success) {
			s.stop(`导入 ${projectName} 失败`);
			printError(`无法读取文件: ${zipPath}`);
			await fse.remove(projectPath).catch(() => {});
			return false;
		}

		const zip = new AdmZip(tmpZip);
		zip.extractAllTo(projectPath, true);
		await fse.remove(tmpZip).catch(() => {});
	} catch (error) {
		s.stop(`导入 ${projectName} 失败`);
		printError((error as Error).message);
		await fse.remove(projectPath).catch(() => {});
		return false;
	}

	s.stop(`${brand.success("✓")} 已导入: ${brand.primary(projectName)}`);
	saveProjectMeta(projectName, { template: "sync" });
	return true;
}

async function handleImport(file?: string) {
	if (file) {
		const zipPath = resolve(file);

		// 用 shell test 检查文件是否存在（绕过 TCC）
		const checkResult = await execAndCapture(
			`test -f "${zipPath}" && echo exists || echo missing`,
			process.cwd(),
		);
		if (checkResult.output.trim() !== "exists") {
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
			await promptDeletePSync();
			outro(brand.success(`✨ 项目 ${projectName} 导入成功！`));
			console.log();
			console.log(pc.dim("  使用 ") + brand.primary("p open " + projectName) + pc.dim(" 打开项目"));
			console.log();
		}
		return;
	}

	// 未指定文件 → 扫描 Downloads 目录
	intro(bgOrange(" 导入项目 "));

	const zips = await scanDownloadsDir();

	if (zips.length === 0) {
			printInfo("Downloads/ 中没有可导入的 .zip 文件");
		console.log(pc.dim("  提示：先在另一台机器上运行 ") + brand.primary("p sync export") + pc.dim(" 并通过 LocalSend 发送"));
		console.log();
		return;
	}

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
			await promptDeletePSync();
			outro(brand.success(`✨ 项目 ${zip.name} 导入成功！`));
			console.log();
			console.log(pc.dim("  使用 ") + brand.primary("p open " + zip.name) + pc.dim(" 打开项目"));
			console.log();
		}
		return;
	}

	console.log(pc.dim(`  找到 ${zips.length} 个可导入的项目:`));
	console.log();

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
		await promptDeletePSync();
		outro(brand.success(`✨ 已成功导入 ${imported} 个项目`));
	} else {
		await promptDeletePSync();
		outro(`${brand.success("✓")} 已导入 ${imported} 个，${selected.length - imported} 个失败`);
	}
	console.log();
}

export const syncCommand = new Command("sync")
	.description("导出/导入项目（配合 LocalSend 等工具在局域网迁移）")
	.addCommand(
		new Command("export")
			.description("导出项目为 ZIP 到 Downloads/p-sync 目录")
			.argument("[name]", "项目名称、. 表示当前目录")
			.action(async (name?: string) => {
				await handleExport(name);
			}),
	)
	.addCommand(
		new Command("import")
			.description("从 ZIP 文件导入项目（自动扫描 Downloads 目录）")
			.argument("[file]", "ZIP 文件路径（不指定则自动扫描）")
			.action(async (file?: string) => {
				await handleImport(file);
			}),
	);
