import { outro, select, spinner } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import {
	getProjectPath,
	projectExists,
	saveProjectMeta,
	validateProjectNameFormat,
} from "../core/project";
import { execAndCapture, openWithIDE } from "../utils/shell";
import { PROJECTS_DIR } from "../utils/paths";
import { brand, printError } from "../utils/ui";

/**
 * 规范化 Git URL：支持 owner/repo 短格式 → 补全为 HTTPS 地址
 */
function normalizeUrl(input: string): string {
	// 已经是完整 URL（包括不带 .git 的 HTTPS）
	if (input.startsWith("https://") || input.startsWith("http://") || input.startsWith("git@") || input.startsWith("ssh://")) {
		// HTTPS 不带 .git → 补全
		if (input.startsWith("https://github.com/") && !input.endsWith(".git")) {
			return `${input}.git`;
		}
		return input;
	}

	// owner/repo 短格式 → 补全为 HTTPS
	if (/^[^/\s]+\/[^/\s]+$/.test(input)) {
		return `https://github.com/${input}.git`;
	}

	return input;
}

/**
 * 从 Git URL 提取项目名称（REPO 部分）
 */
function extractProjectName(url: string): string {
	let name = url.replace(/\.git$/, "");
	name = name.split("/").pop() || name;
	if (name.includes(":")) {
		name = name.split(":").pop() || name;
		name = name.split("/").pop() || name;
	}
	return name;
}

/**
 * 从 Git URL 提取 owner
 */
function extractOwner(url: string): string | null {
	// HTTPS: https://github.com/OWNER/REPO.git
	let match = url.match(/github\.com[:/]([^/]+)\//);
	if (match) return match[1];

	// SSH: git@github.com:OWNER/REPO.git
	match = url.match(/git@[^:]+:([^/]+)\//);
	if (match) return match[1];

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

export const cloneCommand = new Command("clone")
	.alias("cl")
	.description("从远程地址克隆项目到 p 管理")
	.argument("<url>", "Git 仓库地址（支持 owner/repo 短格式）")
	.argument("[name]", "自定义项目名称（默认从 URL 推断）")
	.action(async (url: string, customName?: string) => {
		const config = loadConfig();

		// 规范化 URL：owner/repo → https://github.com/owner/repo.git
		const normalizedUrl = normalizeUrl(url);
		let projectName = customName || extractProjectName(normalizedUrl);

		// 名称验证
		const nameCheck = validateProjectNameFormat(projectName);
		if (!nameCheck.valid) {
			printError(nameCheck.message || "项目名称无效");
			process.exit(1);
		}

		// 冲突检查
		if (projectExists(projectName)) {
			printError(`项目已存在: ${projectName}`);
			console.log(
				pc.dim("使用 ") +
					brand.primary("p open " + projectName) +
					pc.dim(" 打开已有项目"),
			);
			process.exit(1);
		}

		console.log();
		console.log(pc.dim("  仓库地址: ") + pc.underline(normalizedUrl));
		if (url !== normalizedUrl) {
			console.log(pc.dim("  原始输入: ") + pc.dim(url));
		}
		console.log(pc.dim("  项目名称: ") + brand.primary(projectName));
		console.log();

		// 检查 git 用户与仓库 owner 是否一致
		const owner = extractOwner(normalizedUrl);
		const gitUser = await getGitUsername();

		if (owner && gitUser && gitUser.toLowerCase() !== owner.toLowerCase()) {
			printError(`git 用户 (${gitUser}) 与仓库 owner (${owner}) 不一致`);
			console.log(pc.dim("  请先切换到正确的账户后再执行 p clone"));
			process.exit(1);
		}

		// 执行 git clone
		const s = spinner();
		s.start("正在克隆仓库...");

		const projectPath = getProjectPath(projectName);
		const result = await execAndCapture(
			`git clone ${normalizedUrl} ${projectName}`,
			PROJECTS_DIR,
		);

		if (!result.success) {
			s.stop("克隆失败");
			console.log();
			printError("git clone 失败，请检查仓库地址和权限");
			if (result.error) {
				console.log(pc.dim(result.error));
			}
			process.exit(1);
		}

		s.stop(`${brand.success("✓")} 克隆完成`);

		// 保存元数据
		saveProjectMeta(projectName, { template: "clone" });

		// 打开 IDE
		const ideSpinner = spinner();
		ideSpinner.start(`正在用 ${config.ide} 打开 ${projectName}...`);

		try {
			await openWithIDE(config.ide, projectPath);
			ideSpinner.stop(
				`${brand.success("✓")} 已打开: ${brand.primary(projectName)}`,
			);
		} catch (error) {
			ideSpinner.stop(`打开 ${config.ide} 失败`);
			console.log();
			printError((error as Error).message);
			console.log();
			console.log(pc.dim("  项目路径: ") + pc.underline(projectPath));
			console.log();
		}

		outro(brand.success("✨ 项目克隆成功！"));
	});
