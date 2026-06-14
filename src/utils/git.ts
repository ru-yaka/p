import fse from "fs-extra";
import { join } from "node:path";
import { execAndCapture } from "./shell";

/**
 * 移除目录中嵌套的 .git 目录（非顶层）
 * 避免 git add 将子目录当作 gitlink（引用）而非实际文件
 */
export async function removeNestedGitDirs(cwd: string): Promise<number> {
	const result = await execAndCapture("find . -mindepth 2 -name '.git' -type d", cwd);
	if (!result.success) return 0;
	const dirs = result.output.trim().split("\n").filter(Boolean);
	for (const d of dirs) {
		await fse.remove(join(cwd, d));
	}
	return dirs.length;
}
