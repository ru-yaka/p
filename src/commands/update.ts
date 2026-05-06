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
 * 从当前文件位置向上查找 p 安装目录（包含 package.json 且 name 为 p）
 */
function findPDir(): string | null {
	const currentFile = fileURLToPath(import.meta.url);
	let dir = dirname(currentFile);

	for (let i = 0; i < 10; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (pkg.name === "p") return dir;
			} catch {}
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}

export const updateCommand = new Command("update")
	.alias("upgrade")
	.description("更新 p 到最新版本")
	.action(async () => {
		const pDir = findPDir();
		const currentVersion = pDir ? getVersion(pDir) : "unknown";

		intro(bgOrange(" 更新 p "));
		console.log(pc.dim("  当前版本: ") + brand.primary(currentVersion));
		console.log();

		const s = spinner();
		s.start("正在更新...");

		const result = await execAndCapture("bun install -g ru-yaka/p", process.cwd());

		if (!result.success) {
			s.stop("更新失败");
			console.log();
			printError(`更新失败: ${result.error || result.output}`);
			console.log();
			printInfo("手动更新: bun remove -g p && bun install -g ru-yaka/p");
			process.exit(1);
		}

		s.stop("更新完成");

		const newVersion = getVersion(pDir || "");

		console.log();
		if (newVersion !== "unknown" && newVersion !== currentVersion) {
			outro(
				brand.success("p 已更新: ") +
					pc.dim(currentVersion) +
					brand.success(" → ") +
					brand.primary(newVersion),
			);
		} else {
			outro(brand.success("p 已是最新版本"));
		}
	});
