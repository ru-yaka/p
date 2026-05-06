import {
	intro,
	outro,
	spinner,
	text,
} from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import {
	deleteProjectMeta,
	getProjectPath,
	listProjects,
	projectExists,
	saveProjectMeta,
	validateProjectNameFormat,
} from "../core/project";
import { execAndCapture } from "../utils/shell";
import { liveSearch, CANCEL } from "../utils/live-search";
import {
	filterProjects,
	projectHint,
} from "../utils/project-search";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

/**
 * 搜索并选择要重命名的项目
 */
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
		message: "搜索要重命名的项目:",
		placeholder: "输入名称、模板或标签筛选",
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

	return result as string;
}

/**
 * 从 remote URL 提取 owner/repo
 */
function extractRepoSlug(url: string): string | null {
	// HTTPS: https://github.com/OWNER/REPO.git
	let match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
	if (match) return match[1];

	// SSH: git@github.com:OWNER/REPO.git
	match = url.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (match) return match[1];

	return null;
}

/**
 * 获取项目的 git remote origin URL
 */
async function getRemoteOrigin(projectPath: string): Promise<string | null> {
	const result = await execAndCapture("git remote get-url origin", projectPath);
	if (result.success && result.output.trim()) {
		return result.output.trim();
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
 * 重命名 GitHub 仓库
 */
async function renameGitHubRepo(
	oldSlug: string,
	newName: string,
): Promise<{ success: boolean; error?: string }> {
	const result = await execAndCapture(
		`gh repo rename ${newName} --repo ${oldSlug} --yes`,
		process.cwd(),
	);

	if (!result.success) {
		return { success: false, error: result.error || result.output };
	}
	return { success: true };
}

/**
 * 带超时的目录移动
 */
async function moveWithTimeout(
	src: string,
	dest: string,
	timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve({
				success: false,
				error: `操作超时（${timeoutMs / 1000}秒），可能有 IDE 正在占用目录，请关闭该项目窗口后重试`,
			});
		}, timeoutMs);

		fse.move(src, dest)
			.then(() => {
				clearTimeout(timer);
				resolve({ success: true });
			})
			.catch((error) => {
				clearTimeout(timer);
				resolve({ success: false, error: error.message });
			});
	});
}

export const renameCommand = new Command("rename")
	.alias("mv")
	.description("重命名项目")
	.argument("[oldName]", "当前项目名称")
	.argument("[newName]", "新项目名称")
	.action(async (oldName?: string, newName?: string) => {
		const projects = listProjects();

		if (projects.length === 0) {
			console.log();
			printInfo("暂无项目");
			console.log();
			return;
		}

		// 选择要重命名的项目
		let projectName = oldName;
		if (!projectName) {
			projectName = await searchAndSelect(projects);
		} else if (!projectExists(projectName)) {
			// 模糊搜索
			const filtered = filterProjects(projects, projectName);
			if (filtered.length === 1) {
				projectName = filtered[0].name;
			} else if (filtered.length > 1) {
				projectName = await searchAndSelect(projects, projectName);
			} else {
				printError(`项目不存在: ${projectName}`);
				console.log(pc.dim("使用 ") + brand.primary("p ls") + pc.dim(" 查看所有项目"));
				process.exit(1);
			}
		}

		const projectPath = getProjectPath(projectName);

		// 获取新名称
		let newProjectName = newName;
		if (!newProjectName) {
			const result = await text({
				message: "输入新项目名称:",
				placeholder: projectName,
				initialValue: projectName,
				validate: (value) => {
					const v = validateProjectNameFormat(value);
					if (!v.valid) return v.message;
					if (value === projectName) return "新名称不能与当前名称相同";
					if (projectExists(value)) return "项目已存在";
					return undefined;
				},
			});

			if (result === CANCEL) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			newProjectName = (result as string).trim();
		}

		// 验证新名称
		const nameCheck = validateProjectNameFormat(newProjectName);
		if (!nameCheck.valid) {
			printError(nameCheck.message || "项目名称无效");
			process.exit(1);
		}

		if (newProjectName === projectName) {
			printError("新名称不能与当前名称相同");
			process.exit(1);
		}

		if (projectExists(newProjectName)) {
			printError(`项目已存在: ${newProjectName}`);
			process.exit(1);
		}

		intro(bgOrange(" 重命名项目 "));
		console.log();
		console.log(pc.dim("  当前名称: ") + brand.secondary(projectName));
		console.log(pc.dim("  新名称:   ") + brand.primary(newProjectName));
		console.log();

		// 检查是否有远程仓库
		const remoteUrl = await getRemoteOrigin(projectPath);
		const repoSlug = remoteUrl ? extractRepoSlug(remoteUrl) : null;

		if (repoSlug) {
			console.log(pc.dim("  远程仓库: ") + pc.underline(`github.com/${repoSlug}`));

			// 检查 git 用户与仓库 owner 是否一致
			const owner = repoSlug.split("/")[0];
			const gitUser = await getGitUsername();

			if (gitUser && gitUser.toLowerCase() !== owner.toLowerCase()) {
				console.log();
				printError(`git 用户 (${gitUser}) 与仓库 owner (${owner}) 不一致`);
				printInfo("请先切换到正确的账户后再执行 p rename");
				process.exit(1);
			}

			console.log();
		}

		// 重命名远程仓库
		if (repoSlug) {
			const renameSpinner = spinner();
			renameSpinner.start("正在重命名 GitHub 仓库...");

			const result = await renameGitHubRepo(repoSlug, newProjectName);

			if (!result.success) {
				renameSpinner.stop("重命名 GitHub 仓库失败");
				printError(result.error || "未知错误");
				process.exit(1);
			}

			renameSpinner.stop(`${brand.success("✓")} GitHub 仓库已重命名`);
		}

		// 重命名本地目录（5 秒超时）
		const s = spinner();
		s.start("正在重命名本地目录...");

		const newPath = getProjectPath(newProjectName);
		const result = await moveWithTimeout(projectPath, newPath, 5000);

		if (!result.success) {
			s.stop("重命名失败");
			printError(result.error || "未知错误");
			process.exit(1);
		}

		// 更新元数据
		const oldMeta = projects.find((p) => p.name === projectName);
		deleteProjectMeta(projectName);
		saveProjectMeta(newProjectName, {
			template: oldMeta?.template,
			tags: oldMeta?.tags,
		});

		s.stop(`${brand.success("✓")} 已重命名: ${brand.primary(newProjectName)}`);

		console.log();
		outro(brand.success("✨ 重命名完成！"));
	});
