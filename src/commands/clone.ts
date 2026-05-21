import { resolve } from "node:path";
import { outro, spinner } from "@clack/prompts";
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
import { execAndCapture, openWithIDE } from "../utils/shell";
import { PROJECTS_DIR } from "../utils/paths";
import { brand, printError } from "../utils/ui";

/**
 * 规范化 Git URL：支持 owner/repo 短格式 → 补全为 HTTPS 地址
 */
function normalizeUrl(input: string): string {
	if (input.startsWith("https://") || input.startsWith("http://") || input.startsWith("git@") || input.startsWith("ssh://")) {
		if (input.startsWith("https://github.com/") && !input.endsWith(".git")) {
			return `${input}.git`;
		}
		return input;
	}

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
 * 从 Git URL 提取 owner/repo slug
 */
function extractSlug(url: string): { owner: string; repo: string } | null {
	let match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (match) return { owner: match[1], repo: match[2] };

	match = url.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (match) return { owner: match[1], repo: match[2] };

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
 * degit 模式：通过 GitHub tarball 下载（无 git 历史）
 */
async function degitClone(
	owner: string,
	repo: string,
	targetPath: string,
	branch: string,
): Promise<{ success: boolean; error?: string }> {
	const tmpDir = resolve(PROJECTS_DIR, `.tmp-degit-${Date.now()}`);
	try {
		await fse.ensureDir(tmpDir);

		// 尝试 main 分支的 tarball，失败则试 master
		const urls = [
			`https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`,
		];

		let lastError = "";
		for (const tarballUrl of urls) {
			const proc = Bun.spawn(
				["curl", "-fsSL", "-o", "archive.tar.gz", tarballUrl],
				{ cwd: tmpDir, stdout: "pipe", stderr: "pipe" },
			);
			const code = await proc.exited;
			if (code === 0) {
				// 解压
				const tarProc = Bun.spawn(
					["tar", "-xzf", "archive.tar.gz"],
					{ cwd: tmpDir, stdout: "pipe", stderr: "pipe" },
				);
				await tarProc.exited;

				// tarball 解压后会有一个 owner-repo-xxxx 前缀的目录
				const entries = await fse.readdir(tmpDir);
				const contentDir = entries.find((e) => e !== "archive.tar.gz");

				if (contentDir) {
					const contentPath = resolve(tmpDir, contentDir);
					await fse.move(contentPath, targetPath);
					return { success: true };
				}
			}
			// 记录错误但不立即失败，尝试 fallback
			const err = await new Response(proc.stderr).text();
			lastError = err;
		}

		return { success: false, error: lastError || "下载失败" };
	} catch (error) {
		return { success: false, error: (error as Error).message };
	} finally {
		await fse.remove(tmpDir).catch(() => {});
	}
}

export const cloneCommand = new Command("clone")
	.alias("cl")
	.description("从远程地址克隆项目到 p 管理")
	.argument("<url>", "Git 仓库地址（支持 owner/repo 短格式）")
	.argument("[name]", "自定义项目名称（默认从 URL 推断）")
	.option("--degit", "丢弃 git 历史，仅下载文件（类似 degit）")
	.action(async (url: string, customName?: string, options?: { degit?: boolean }) => {
		const config = loadConfig();

		const normalizedUrl = normalizeUrl(url);
		let projectName = customName || extractProjectName(normalizedUrl);

		const nameCheck = validateProjectNameFormat(projectName);
		if (!nameCheck.valid) {
			printError(nameCheck.message || "项目名称无效");
			process.exit(1);
		}

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

		if (options?.degit) {
			console.log(pc.dim("  degit 模式：不包含 .git 目录（无历史提交记录）"));
			console.log();
		}

		const projectPath = getProjectPath(projectName);
		const s = spinner();
		s.start(`正在克隆项目：${projectName}...`);

		if (options?.degit) {
			// degit 模式
			const slug = extractSlug(normalizedUrl);
			if (slug) {
				// GitHub 仓库 → tarball 下载
				const result = await degitClone(slug.owner, slug.repo, projectPath, "main");
				if (!result.success) {
					// main 失败，试 master
					const retry = await degitClone(slug.owner, slug.repo, projectPath, "master");
					if (!retry.success) {
						s.stop("克隆失败");
						console.log();
						printError("下载失败，请检查仓库地址和权限");
						console.log(pc.dim("  提示：可去掉 --degit 使用完整 git clone"));
						process.exit(1);
					}
				}
			} else {
				// 非 GitHub → shallow clone + 删 .git
				const result = await execAndCapture(
					`git clone --depth 1 ${normalizedUrl} ${projectName}`,
					PROJECTS_DIR,
				);
				if (!result.success) {
					s.stop("克隆失败");
					console.log();
					printError("git clone 失败，请检查仓库地址和权限");
					if (result.error) console.log(pc.dim(result.error));
					process.exit(1);
				}
				await fse.remove(resolve(projectPath, ".git")).catch(() => {});
			}
		} else {
			// 普通 git clone
			const owner = extractSlug(normalizedUrl)?.owner ?? null;
			const gitUser = await getGitUsername();

			if (owner && gitUser && gitUser.toLowerCase() !== owner.toLowerCase()) {
				console.log(
					pc.dim(
						`  ⚠ git 用户 (${gitUser}) 与仓库 owner (${owner}) 不一致，后续 push 请注意远程仓库地址`,
					),
				);
			}

			const result = await execAndCapture(
				`git clone ${normalizedUrl} ${projectName}`,
				PROJECTS_DIR,
			);

			if (!result.success) {
				s.stop("克隆失败");
				console.log();
				printError("git clone 失败，请检查仓库地址和权限");
				if (result.error) console.log(pc.dim(result.error));
				process.exit(1);
			}
		}

		s.stop(`${brand.success("✓")} 克隆完成`);

		saveProjectMeta(projectName, { template: "clone" });

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
