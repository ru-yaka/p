import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { confirm, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { listProjects, getProjectPath, saveProjectMeta } from "../core/project";
import { markTemplatePublished } from "../core/template";
import { removeNestedGitDirs } from "../utils/git";
import { collectProjectFiles, copyFiles } from "../utils/files";
import { liveSearch, CANCEL } from "../utils/live-search";
import { filterProjects } from "../utils/project-search";
import { TEMPLATES_DIR } from "../utils/paths";
import { execAndCapture } from "../utils/shell";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

async function git(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	return { ok: code === 0, output: err || out };
}

async function getGitRemoteUrl(projectPath: string): Promise<string | null> {
	const result = await execAndCapture("git remote get-url origin", projectPath);
	return result.success ? result.output.trim() : null;
}

async function publishWithRemote(projectPath: string, templateName: string) {
	const remoteUrl = await getGitRemoteUrl(projectPath);
	if (!remoteUrl) return false;

	// 从 remote URL 解析 owner/repo
	const match = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
	if (!match) return false;

	const [, owner, repo] = match;
	const cleanRepo = repo.replace(/\.git$/, "");

	intro(bgOrange(" 发布模板 "));
	console.log(pc.dim("  仓库: ") + brand.primary(`${owner}/${cleanRepo}`));
	console.log();

	const shouldPublish = await confirm({
		message: `是否将 ${brand.primary(templateName)} 推送到远程？`,
	});
	if (isCancel(shouldPublish) || !shouldPublish) {
		outro(pc.dim("已取消"));
		return true;
	}

	const s = spinner();
	s.start("正在推送...");

	const removed = await removeNestedGitDirs(projectPath);
	if (removed > 0) {
		console.log(pc.dim(`  已清理 ${removed} 个嵌套 .git 目录`));
	}

	const addResult = await git(["add", "-A"], projectPath);
	if (!addResult.ok) {
		s.stop("git add 失败");
		printError(addResult.output);
		return true;
	}

	// 尝试 commit，如果没变化会失败，跳过即可
	await git(["commit", "-m", "Update"], projectPath);

	// 先尝试普通 push，失败则 force push
	let pushResult = await git(["push", "origin", "HEAD"], projectPath);
	if (!pushResult.ok) {
		console.log(pc.dim("  ⚠ 普通推送失败，正在强制推送..."));
		pushResult = await git(["push", "--force", "origin", "HEAD"], projectPath);
	}
	if (!pushResult.ok) {
		s.stop("推送失败");
		printError(pushResult.output);
		return true;
	}

	const branchResult = await git(["branch", "--show-current"], projectPath);
	const branch = branchResult.output.trim();

	s.stop(`${brand.success("✓")} 已推送到远程 (${branch})`);

	markTemplatePublished(templateName, owner, cleanRepo);

	console.log();
	console.log(pc.dim("  克隆链接: ") + pc.underline(`https://github.com/${owner}/${cleanRepo}.git`));
	console.log();
	return true;
}

async function publishNewRepo(projectPath: string, templateName: string, saveAsLocal: boolean) {
	intro(bgOrange(" 发布模板 "));
	console.log(pc.dim("  模板: ") + brand.primary(templateName));
	console.log();

	const shouldPublish = await confirm({
		message: `确认将 ${brand.primary(templateName)} 发布到 GitHub？`,
	});
	if (isCancel(shouldPublish) || !shouldPublish) {
		outro(pc.dim("已取消"));
		return;
	}

	const s = spinner();
	s.start("正在准备...");

	// 收集项目文件
	const { success, files, message } = await collectProjectFiles(projectPath);
	if (!success || files.length === 0) {
		s.stop("收集文件失败");
		printError(message || "项目没有文件");
		return;
	}

	// 如果需要保存为本地模板
	if (saveAsLocal) {
		s.stop(`${brand.success("✓")} 找到 ${files.length} 个文件`);
		await fse.ensureDir(TEMPLATES_DIR);
		await copyFiles(projectPath, join(TEMPLATES_DIR, templateName), files);

		// 确认保存
		intro(bgOrange(" 添加模板 "));
		console.log(pc.dim(`  模板位置: ${TEMPLATES_DIR}/${templateName}`));
		console.log();
	}

	// 创建临时目录作为 git 仓库
	const tmpDir = join(homedir(), ".p", ".tmp-publish");
	await fse.remove(tmpDir).catch(() => {});
	await fse.ensureDir(tmpDir);

	// 复制文件到临时目录
	for (const file of files) {
		const src = join(projectPath, file);
		const dest = join(tmpDir, file);
		if (await fse.pathExists(src)) {
			await fse.ensureDir(join(tmpDir, file.split("/").slice(0, -1).join("/")));
			await fse.copyFile(src, dest);
		}
	}

	s.start("正在创建 GitHub 仓库...");

	// gh repo create
	const proc = Bun.spawn(
		["gh", "repo", "create", templateName, "--public", "--description", `p template: ${templateName}`],
		{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const output = stdout + stderr;

	let owner = "";
	const urlMatch = output.match(/https:\/\/github\.com\/([^/]+)\/[^\s/]+/);
	if (urlMatch) {
		owner = urlMatch[1];
	} else {
		const whoami = await execAndCapture("gh api user --jq .login", process.cwd());
		owner = whoami.success ? whoami.output.trim() : "";
	}

	if (!owner) {
		s.stop("获取 GitHub 用户名失败");
		printError(output || "请确认已安装并登录 GitHub CLI (gh)");
		await fse.remove(tmpDir).catch(() => {});
		return;
	}

	if (exitCode !== 0 && !output.includes("Name already exists")) {
		s.stop("创建仓库失败");
		printError(output);
		await fse.remove(tmpDir).catch(() => {});
		return;
	}

	const cloneUrl = `https://github.com/${owner}/${templateName}.git`;

	if (exitCode === 0) {
		s.stop(`${brand.success("✓")} 仓库已创建: ${brand.primary(`${owner}/${templateName}`)}`);
	} else {
		s.stop(`${brand.success("✓")} 仓库已存在: ${brand.primary(`${owner}/${templateName}`)}`);
	}

	s.start("正在推送文件...");

	// git init + commit + push
	await git(["init"], tmpDir);
	await git(["remote", "add", "origin", cloneUrl], tmpDir);
	await git(["add", "-A"], tmpDir);
	await git(["commit", "-m", "init: p template"], tmpDir);

	const branchResult = await git(["branch", "--show-current"], tmpDir);
	const branch = branchResult.output.trim() || "main";

	let pushResult = await git(["push", "-u", "--force", "origin", branch], tmpDir);
	if (!pushResult.ok && branch === "main") {
		await git(["branch", "-M", "master"], tmpDir);
		pushResult = await git(["push", "-u", "--force", "origin", "master"], tmpDir);
	}

	if (!pushResult.ok) {
		s.stop("推送失败");
		printError(pushResult.output);
		await fse.remove(tmpDir).catch(() => {});
		return;
	}

	// 清理临时目录
	await fse.remove(tmpDir).catch(() => {});

	markTemplatePublished(templateName, owner, templateName);

	s.stop(`${brand.success("✓")} 已推送 ${brand.primary(files.length.toString())} 个文件`);

	if (saveAsLocal) {
		const projects = listProjects();
		const currentProject = projects.find((p) => p.path === projectPath);
		if (currentProject) {
			saveProjectMeta(currentProject.name, { savedTemplate: templateName });
		}
	}

	console.log();
	console.log(pc.dim("  克隆链接: ") + pc.underline(cloneUrl));
	console.log();
}

export const publishCommand = new Command("publish")
	.description("发布项目为 GitHub 模板仓库")
	.argument("[name]", "项目名称或 . 表示当前目录")
	.argument("[template-name]", "模板名称（不指定则使用项目名）")
	.option("--save", "同时保存为本地模板")
	.action(async (name?: string, templateNameArg?: string, options?: { save?: boolean }) => {
		let projectPath: string;
		let projectName: string;

		if (name === ".") {
			projectPath = process.cwd();
			projectName = basename(projectPath);
		} else if (name) {
			const projects = listProjects();
			if (!projects.find((p) => p.name === name)) {
				const filtered = filterProjects(projects, name);
				if (filtered.length === 1) {
					projectName = filtered[0].name;
				} else {
					printError(`项目不存在: ${name}`);
					process.exit(1);
				}
			} else {
				projectName = name;
			}
			projectPath = getProjectPath(projectName);
		} else {
			const projects = listProjects();
			const currentProject = projects.find((p) => p.path === process.cwd());
			if (currentProject) {
				projectPath = currentProject.path;
				projectName = currentProject.name;
			} else {
				projectPath = process.cwd();
				projectName = basename(projectPath);
			}
		}

		const templateName = templateNameArg || projectName;

		// 检查是否有 git remote
		const hasRemote = await getGitRemoteUrl(projectPath);
		if (hasRemote) {
			const handled = await publishWithRemote(projectPath, templateName);
			if (handled) return;
		}

		// 无 remote → 创建新仓库
		await publishNewRepo(projectPath, templateName, !!options?.save);
	});
