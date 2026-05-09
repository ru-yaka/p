import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { P_ROOT } from "./paths";
import { brand } from "./ui";

// IDE 缓存文件路径
const IDE_CACHE_PATH = join(P_ROOT, "ide-cache.json");

// 内存缓存
let ideCache: Record<string, string> | null = null;

/**
 * 加载 IDE 缓存
 */
function loadIDECache(): Record<string, string> {
	if (ideCache) return ideCache;
	if (!existsSync(IDE_CACHE_PATH)) {
		ideCache = {};
		return ideCache;
	}
	try {
		ideCache = JSON.parse(readFileSync(IDE_CACHE_PATH, "utf-8"));
		return ideCache;
	} catch {
		ideCache = {};
		return ideCache;
	}
}

/**
 * 保存 IDE 缓存
 */
function saveIDECache(): void {
	writeFileSync(IDE_CACHE_PATH, JSON.stringify(ideCache, null, 2));
}

/**
 * 在指定目录执行命令（显示命令和输出）
 */
export async function execInDir(
	command: string,
	cwd: string,
	options: { silent?: boolean; captureStderr?: boolean } = {},
): Promise<{ success: boolean; output: string; stderr?: string }> {
	if (!options.silent) {
		console.log(pc.dim("  $ ") + brand.secondary(command));
	}

	try {
		const isWindows = process.platform === "win32";
		const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
		const shellArgs = isWindows ? ["/c"] : ["-c"];

		const proc = Bun.spawn([shell, ...shellArgs, command], {
			cwd,
			stdin: "inherit",
			stdout: "inherit",
			stderr: options.captureStderr ? "pipe" : "inherit",
			env: {
				...process.env,
				FORCE_COLOR: "3",
			},
		});

		let stderrOutput = "";
		if (options.captureStderr && proc.stderr) {
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stderrOutput += decoder.decode(value, { stream: true });
				process.stderr.write(value);
			}
		}

		const exitCode = await proc.exited;

		return {
			success: exitCode === 0,
			output: "",
			stderr: stderrOutput,
		};
	} catch (error) {
		const err = error as Error;
		return { success: false, output: err.message };
	}
}

/**
 * 在指定目录执行命令并捕获输出（用于需要解析输出的场景）
 */
export async function execAndCapture(
	command: string,
	cwd: string,
): Promise<{ success: boolean; output: string; error: string }> {
	try {
		const isWindows = process.platform === "win32";
		const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
		const shellArgs = isWindows ? ["/c"] : ["-c"];

		const proc = Bun.spawn([shell, ...shellArgs, command], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		const exitCode = await proc.exited;
		const output = await new Response(proc.stdout).text();
		const errorOutput = await new Response(proc.stderr).text();

		return {
			success: exitCode === 0,
			output: output.trim(),
			error: errorOutput.trim(),
		};
	} catch (error) {
		const err = error as Error;
		return { success: false, output: "", error: err.message };
	}
}

/**
 * 用 IDE 打开路径
 */
export async function openWithIDE(
	ide: string,
	path: string,
	fuzzy = false,
): Promise<{ resolved: string }> {
	const resolved = fuzzy ? resolveCommand(ide) : ide;
	try {
		await $`${resolved} ${path}`.quiet();
		return { resolved };
	} catch {
		throw new Error(
			`无法打开 ${ide}，请确保 ${resolved} 命令已安装并添加到 PATH 环境变量。`,
		);
	}
}

/**
 * 在 PATH 中查找以 prefix 开头的命令（带缓存）
 */
function resolveCommand(prefix: string): string {
	const cache = loadIDECache();

	if (cache[prefix]) {
		return cache[prefix];
	}

	const isWindows = process.platform === "win32";
	const pathEnv = process.env.PATH || "";
	const pathSep = isWindows ? ";" : ":";
	const paths = pathEnv.split(pathSep);

	const candidates: string[] = [];

	for (const dir of paths) {
		try {
			const files = readdirSync(dir);
			for (const file of files) {
				const name = isWindows && file.endsWith(".exe")
					? file.slice(0, -4)
					: file;
				if (name.startsWith(prefix)) {
					candidates.push(name);
				}
			}
		} catch {
			// 目录不存在或无权限，跳过
		}
	}

	const resolved = candidates.includes(prefix)
		? prefix
		: candidates[0] || prefix;

	if (resolved !== prefix) {
		cache[prefix] = resolved;
		saveIDECache();
	}

	return resolved;
}

/**
 * 检查命令是否存在
 */
export async function commandExists(command: string): Promise<boolean> {
	try {
		await $`which ${command}`.quiet();
		return true;
	} catch {
		return false;
	}
}
