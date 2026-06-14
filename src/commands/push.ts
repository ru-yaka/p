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

export const pushCommand = new Command("push")
	.alias("pu")
	.description("提交并推送项目代码到 remote origin")
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

		// 检查 remote
		const remoteResult = await execAndCapture("git remote get-url origin", projectPath);
		if (!remoteResult.success) {
			printError(`项目 ${brand.primary(projectName)} 没有 remote origin`);
			process.exit(1);
		}

		const remoteUrl = remoteResult.output.trim();
		intro(bgOrange(` Push · ${projectName} `));
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

		// git commit（无变更则跳过）
		const s2 = spinner();
		s2.start("正在提交...");
		const commitResult = await git(["commit", "-m", "update"], projectPath);

		if (!commitResult.ok && !commitResult.output.includes("nothing to commit")) {
			s2.stop("提交失败");
			printError(commitResult.output);
			process.exit(1);
		}

		const nothingToCommit = commitResult.output.includes("nothing to commit");
		s2.stop(nothingToCommit ? `${brand.success("✓")} 没有变更需要提交` : `${brand.success("✓")} 已提交`);

		if (nothingToCommit) {
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
