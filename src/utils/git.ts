import fse from "fs-extra";
import { join } from "node:path";
import { execAndCapture } from "./shell";

/**
 * 清理嵌套 .git 目录和 git index 中的 gitlink 条目
 * 1. 扫描并删除嵌套的 .git 目录，同时 git rm --cached 对应父目录
 * 2. 扫描 git index 中已有的 gitlink (mode 160000) 条目并清除
 */
export async function removeNestedGitDirs(cwd: string): Promise<number> {
	let count = 0;

	// 1. 从磁盘删除嵌套 .git 目录
	const findResult = await execAndCapture("find . -mindepth 2 -name '.git' -type d", cwd);
	if (findResult.success) {
		const dirs = findResult.output.trim().split("\n").filter(Boolean);
		for (const d of dirs) {
			const parentDir = d.replace(/^\.\//, "").replace(/\/\.git$/, "");
			await fse.remove(join(cwd, d));
			await execAndCapture(`git rm --cached "${parentDir}" 2>/dev/null`, cwd);
			count++;
		}
	}

	// 2. 清除 git index 中残留的 gitlink 条目 (mode 160000)
	const lsResult = await execAndCapture("git ls-files -s | grep '^160000'", cwd);
	if (lsResult.success) {
		const gitlinks = lsResult.output.trim().split("\n").filter(Boolean);
		for (const line of gitlinks) {
			const path = line.split("\t")[1];
			if (path) {
				await execAndCapture(`git rm --cached "${path}" 2>/dev/null`, cwd);
				count++;
			}
		}
	}

	return count;
}
