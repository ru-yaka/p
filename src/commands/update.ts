import { intro, outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import pc from "picocolors";
import { execAndCapture } from "../utils/shell";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

function getVersion(dir: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
		return pkg.version;
	} catch {
		return "unknown";
	}
}

/**
 * 从当前文件位置向上查找 p 项目根目录（包含 .git 和 package.json）
 */
function findPCliDir(): string | null {
	const currentFile = fileURLToPath(import.meta.url);
	let dir = dirname(currentFile);

	for (let i = 0; i < 10; i++) {
		if (
			existsSync(join(dir, ".git")) &&
			existsSync(join(dir, "package.json"))
		) {
			return dir;
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break; // 到达根目录
		dir = parent;
	}

	return null;
}

/**
 * 获取当前 git 配置的用户名
 */
async function getGitUsername(): Promise<string | null> {
	const result = await execAndCapture("git config user.name", process.cwd());
	if (result.success && result.output.trim()) {
		return result.output.trim();
	}
	return null;
}

/**
 * 从 remote URL 提取 owner
 */
function extractOwnerFromRemote(url: string): string | null {
	// HTTPS: https://github.com/OWNER/REPO.git
	let match = url.match(/github\.com[:/]([^/]+)\//);
	if (match) return match[1];

	// SSH: git@github.com:OWNER/REPO.git
	match = url.match(/git@[^:]+:([^/]+)\//);
	if (match) return match[1];

	return null;
}

export const updateCommand = new Command("update")
	.alias("upgrade")
	.description("更新 p 到最新版本")
	.action(async () => {
		const pCliDir = findPCliDir();

		if (!pCliDir) {
			printError("无法定位 p 项目目录");
			printInfo("请手动更新: cd <p目录> && git pull && bun install && bun run link");
			process.exit(1);
		}

		const currentVersion = getVersion(pCliDir);

		intro(bgOrange(" 更新 p "));
		console.log(pc.dim("  当前版本: ") + brand.primary(currentVersion));
		console.log();

		// 检查 git 用户与仓库 owner 是否一致
		const remoteResult = await execAndCapture("git remote get-url origin", pCliDir);
		const gitUser = await getGitUsername();

		if (remoteResult.success && gitUser) {
			const owner = extractOwnerFromRemote(remoteResult.output);
			if (owner && gitUser.toLowerCase() !== owner.toLowerCase()) {
				printError(`git 用户 (${gitUser}) 与仓库 owner (${owner}) 不一致`);
				printInfo("请先切换到正确的账户后再执行 p update");
				process.exit(1);
			}
		}

		const s = spinner();
		s.start("正在拉取最新代码...");

		// git pull
		const pullResult = await execAndCapture("git pull", pCliDir);

		if (!pullResult.success) {
			s.stop("拉取失败");
			console.log();
			printError(`git pull 失败: ${pullResult.error || pullResult.output}`);
			console.log();
			printInfo(`手动更新: cd ${pCliDir} && git pull && bun install && bun run link`);
			process.exit(1);
		}

		// 检查是否有更新
		if (pullResult.output.includes("Already up to date")) {
			s.stop("已是最新版本");
			console.log();
			outro(brand.success(`p 已是最新版本 (${currentVersion})`));
			return;
		}

		s.stop("代码已更新");

		// 安装依赖
		const installSpinner = spinner();
		installSpinner.start("正在安装依赖...");

		const installResult = await execAndCapture("bun install", pCliDir);

		if (!installResult.success) {
			installSpinner.stop("安装依赖失败");
			console.log();
			printError(`bun install 失败: ${installResult.error || installResult.output}`);
			process.exit(1);
		}

		installSpinner.stop("依赖安装完成");

		// 构建
		const buildSpinner = spinner();
		buildSpinner.start("正在构建...");

		const buildResult = await execAndCapture("bun run build", pCliDir);

		if (!buildResult.success) {
			buildSpinner.stop("构建失败");
			console.log();
			printError(`构建失败: ${buildResult.error || buildResult.output}`);
			process.exit(1);
		}

		buildSpinner.stop("构建完成");

		const newVersion = getVersion(pCliDir);

		console.log();
		outro(
			brand.success("p 已更新: ") +
				pc.dim(currentVersion) +
				brand.success(" → ") +
				brand.primary(newVersion),
		);
	});
