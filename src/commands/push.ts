import { basename } from "node:path";
import { intro, outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

import {
	getProjectPath,
	listProjects,
} from "../core/project";
import { removeNestedGitDirs } from "../utils/git";
import { execAndCapture } from "../utils/shell";
import { filterProjects } from "../utils/project-search";
import { bgOrange, brand, printError } from "../utils/ui";

async function git(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	return { ok: code === 0, output: err || out };
}

async function ensureRemote(projectPath: string, projectName: string): Promise<string> {
	const existing = await execAndCapture("git remote get-url origin", projectPath);
	if (existing.success) return existing.output.trim();

	// 无 remote → 创建 GitHub 私有仓库
	const whoami = await execAndCapture("gh api user --jq .login", process.cwd());
	const owner = whoami.success ? whoami.output.trim() : "";
	if (!owner) {
		printError("请先安装并登录 GitHub CLI (gh)");
		process.exit(1);
	}

	const s = spinner();
	s.start(`正在创建私有仓库 ${owner}/${projectName}...`);

	const proc = Bun.spawn(
		["gh", "repo", "create", projectName, "--private", "--description", `p: ${projectName}`],
		{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	const urlMatch = (stdout + stderr).match(/https:\/\/github\.com\/([^/]+)\/[^\s/]+/);
	const repoOwner = urlMatch ? urlMatch[1] : owner;
	const cloneUrl = `https://github.com/${repoOwner}/${projectName}.git`;

	await git(["remote", "add", "origin", cloneUrl], projectPath);

	s.stop(`${brand.success("✓")} 已创建私有仓库: ${brand.primary(`${repoOwner}/${projectName}`)}`);
	console.log();
	return cloneUrl;
}

export const pushCommand = new Command("push")
	.alias("pu")
	.description("提交并推送项目代码到 remote origin（无 remote 则自动创建私有仓库）")
	.argument("[name]", "项目名称或 . 表示当前目录")
	.action(async (name?: string) => {
		let projectPath: string;
		let projectName: string;

		if (name === ".") {
			projectPath = process.cwd();
			projectName = basename(projectPath);
		} else if (name) {
			const projects = listProjects();
			const exact = projects.find((p) => p.name === name);
			if (exact) {
				projectName = exact.name;
				projectPath = exact.path;
			} else {
				const filtered = filterProjects(projects, name);
				if (filtered.length === 1) {
					projectName = filtered[0].name;
					projectPath = filtered[0].path;
				} else {
					printError(`项目不存在: ${name}`);
					process.exit(1);
				}
			}
		} else {
			projectPath = process.cwd();
			const currentProject = listProjects().find((p) => p.path === projectPath);
			projectName = currentProject?.name || basename(projectPath);
		}

		intro(bgOrange(` Push · ${projectName} `));

		// 检查/创建 remote
		const remoteUrl = await ensureRemote(projectPath, projectName);
		console.log(pc.dim("  remote:   ") + pc.underline(remoteUrl));
		console.log();

		// 清理嵌套 .git 目录
		const removed = await removeNestedGitDirs(projectPath);
		if (removed > 0) {
			console.log(pc.dim(`  已清理 ${removed} 个嵌套 .git 目录`));
		}

		// git add -A
		const s1 = spinner();
		s1.start("正在暂存文件...");

		const addResult = await git(["add", "-A"], projectPath);
		if (!addResult.ok) {
			s1.stop("暂存失败");
			printError(addResult.output);
			process.exit(1);
		}
		s1.stop(`${brand.success("✓")} 已暂存`);

		// 检查是否有 staged 变更，避免无变更时触发 pre-commit hook
		const stagedCheck = await git(["diff", "--cached", "--quiet"], projectPath);
		const hasStaged = !stagedCheck.ok;

		if (hasStaged) {
			const s2 = spinner();
			s2.start("正在提交...");
			const commitResult = await git(["commit", "-m", "update"], projectPath);
			if (!commitResult.ok) {
				s2.stop("提交失败");
				printError(commitResult.output);
				process.exit(1);
			}
			s2.stop(`${brand.success("✓")} 已提交`);
		} else {
			console.log(pc.dim("  没有变更需要提交"));
		}

		// 检查本地是否领先远程（有未推送的 commits）
		const aheadCheck = await git(
			["rev-list", "--count", "@{u}..HEAD"],
			projectPath,
		);
		const hasUpstream = aheadCheck.ok;
		const aheadCount = hasUpstream
			? Number.parseInt(aheadCheck.output.trim(), 10) || 0
			: 0;

		// 无新变更 + 已有 upstream 且远程已同步 → 无需推送
		if (!hasStaged && hasUpstream && aheadCount === 0) {
			console.log();
			outro(brand.success("无需推送"));
			return;
		}

		// git push
		const s3 = spinner();
		s3.start("正在推送...");

		let pushResult = await git(["push", "origin", "HEAD"], projectPath);
		if (!pushResult.ok) {
			console.log(pc.dim("  普通推送失败，尝试强制推送..."));
			pushResult = await git(["push", "--force", "origin", "HEAD"], projectPath);
		}

		if (!pushResult.ok) {
			s3.stop("推送失败");
			printError(pushResult.output);
			process.exit(1);
		}

		const branchResult = await git(["branch", "--show-current"], projectPath);
		const branch = branchResult.output.trim();

		s3.stop(`${brand.success("✓")} 已推送到远程 (${branch})`);
		console.log();
		outro(brand.success("✨ 推送成功"));
	});
