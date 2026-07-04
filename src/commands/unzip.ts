import { basename, dirname, join, parse } from "node:path";
import { confirm, intro, outro, spinner } from "@clack/prompts";
import AdmZip from "adm-zip";
import { Command } from "commander";
import fse from "fs-extra";
import { glob } from "glob";
import pc from "picocolors";
import { getProjectPath, projectExists } from "../core/project";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

// 哈希后缀：7-40 位十六进制（GitHub short SHA 到完整 SHA）
const HASH_SUFFIX = /-([a-f0-9]{7,40})$/i;

// 最小公共前缀长度（短于这个长度视作噪声）
const MIN_PREFIX_LEN = 3;

// 自动清理：循环移除 -template 和哈希后缀（处理多种顺序/组合）
function autoClean(name: string): string {
	let cleaned = name;
	let prev = "";
	while (prev !== cleaned) {
		prev = cleaned;
		cleaned = cleaned.replace(HASH_SUFFIX, "").replace(/-template$/i, "");
	}
	return cleaned;
}

// 检测一组名字的公共 dash-token 前缀（按第一 token 聚类）
// 返回所有被 ≥2 个名字作为首 token 共享、且长度 ≥ MIN_PREFIX_LEN 的前缀
function detectCommonPrefixes(names: string[]): string[] {
	if (names.length < 2) return [];

	const groups = new Map<string, number>();
	for (const name of names) {
		const tokens = name.split("-");
		if (tokens.length < 2) continue; // 至少留 1 个 token 作后缀
		const first = tokens[0];
		groups.set(first, (groups.get(first) ?? 0) + 1);
	}

	const prefixes: string[] = [];
	for (const [token, count] of groups) {
		if (count >= 2 && token.length >= MIN_PREFIX_LEN) {
			prefixes.push(token);
		}
	}
	return prefixes;
}

function stripPrefix(name: string, prefix: string): string {
	if (name.startsWith(prefix + "-")) {
		return name.slice(prefix.length + 1);
	}
	return name;
}

function stripSuffix(name: string, suffix: string): string {
	if (name.endsWith("-" + suffix)) {
		return name.slice(0, name.length - suffix.length - 1);
	}
	return name;
}

type UnzipOptions = {
	auto?: boolean;
	removePrefix?: string[];
	removeSuffix?: string[];
};

export const unzipCommand = new Command("unzip")
	.description("解压项目中所有 zip 文件")
	.argument("[project]", "项目名称（. 或省略表示当前目录）")
	.option("-a, --auto", "跳过所有询问，按默认规则自动清理")
	.option(
		"-r, --remove-prefix <prefix>",
		"手动指定要移除的前缀（可多次使用，不询问）",
		(val: string, prev: string[]) => [...prev, val],
		[],
	)
	.option(
		"-s, --remove-suffix <suffix>",
		"手动指定要移除的后缀（可多次使用，不询问）",
		(val: string, prev: string[]) => [...prev, val],
		[],
	)
	.action(async (project?: string, options: UnzipOptions = {}) => {
		// 确定工作目录
		let cwd: string;

		if (!project || project === ".") {
			cwd = process.cwd();
		} else if (projectExists(project)) {
			cwd = getProjectPath(project);
		} else {
			printError(`项目不存在: ${project}`);
			process.exit(1);
		}

		// 查找所有 zip 文件
		const zipFiles = await glob("**/*.zip", {
			cwd,
			nodir: true,
			absolute: true,
		});

		if (zipFiles.length === 0) {
			console.log();
			printInfo("没有找到 zip 文件");
			console.log();
			return;
		}

		// 预计算：每个 zip 的原始名、清理后名
		const zipInfos = zipFiles.map((file) => {
			const internalName = parse(file).name;
			const cleaned = autoClean(internalName);
			return { file, internalName, cleaned, finalName: "" };
		});

		const anyCleaned = zipInfos.some((z) => z.cleaned !== z.internalName);
		const manualPrefixes = options.removePrefix ?? [];

		intro(bgOrange(" 解压 zip 文件 "));
		console.log();
		console.log(pc.dim(`  找到 ${zipFiles.length} 个 zip 文件:`));
		for (const info of zipInfos) {
			const tail =
				info.cleaned !== info.internalName ? pc.dim(` → ${info.cleaned}`) : "";
			console.log(`  ${brand.secondary("•")} ${basename(info.file)}${tail}`);
		}
		console.log();

		// 先检测公共前缀并询问（基于清理后的名字，按第一 token 聚类）
		const detectedPrefixes = detectCommonPrefixes(
			zipInfos.map((z) => z.cleaned),
		);
		const prefixesToRemove = new Set<string>(manualPrefixes);
		for (const prefix of detectedPrefixes) {
			if (options.auto) {
				prefixesToRemove.add(prefix);
				continue;
			}
			const should = await confirm({
				message: `检测到公共前缀 "${prefix}"，是否移除？`,
				initialValue: true,
			});
			if (should) prefixesToRemove.add(prefix);
		}

		// 再询问 -template / 哈希后缀移除
		let applyAutoClean: boolean;
		if (options.auto) {
			applyAutoClean = anyCleaned;
		} else if (anyCleaned) {
			applyAutoClean = await confirm({
				message: "检测到 -template / 哈希后缀，是否移除？",
				initialValue: true,
			});
		} else {
			applyAutoClean = false;
		}
		console.log();

		const manualSuffixes = options.removeSuffix ?? [];

		for (const info of zipInfos) {
			let name = applyAutoClean ? info.cleaned : info.internalName;
			for (const prefix of prefixesToRemove) {
				name = stripPrefix(name, prefix);
			}
			for (const suffix of manualSuffixes) {
				name = stripSuffix(name, suffix);
			}
			info.finalName = name || info.internalName;
		}

		const s = spinner();
		s.start("正在解压...");

		let successCount = 0;
		const errors: string[] = [];

		for (const { file: zipFile, internalName, finalName } of zipInfos) {
			const relativePath = basename(zipFile);
			try {
				const destDir = join(dirname(zipFile), finalName);

				// 如果目标目录已存在，先删除
				if (await fse.pathExists(destDir)) {
					await fse.remove(destDir);
				}

				const zip = new AdmZip(zipFile);
				const entries = zip.getEntries();

				// 过滤 __MACOSX 和 .DS_Store
				const validEntries = entries.filter((entry) => {
					const name = entry.entryName;
					return (
						!name.startsWith("__MACOSX") &&
						!name.includes("/__MACOSX") &&
						!name.endsWith(".DS_Store")
					);
				});

				// 检查是否需要 flatten：如果所有条目都在同一个根目录下
				const rootDirs = new Set(
					validEntries
						.filter((e) => !e.isDirectory)
						.map((e) => e.entryName.split("/")[0]),
				);

				// 计算 flatten 偏移：唯一根目录名等于原始 internalName 或清理后名字，则跳过它
				let stripPrefix = "";
				if (rootDirs.size === 1) {
					const root = [...rootDirs][0];
					if (root === internalName || root === finalName) {
						stripPrefix = root + "/";
					}
				}

				for (const entry of validEntries) {
					const entryPath = entry.entryName;
					const targetRelPath = stripPrefix
						? entryPath.startsWith(stripPrefix)
							? entryPath.slice(stripPrefix.length)
							: entryPath
						: entryPath;

					if (!targetRelPath) continue;

					const fullPath = join(destDir, targetRelPath);

					if (entry.isDirectory) {
						await fse.ensureDir(fullPath);
					} else {
						await fse.ensureDir(dirname(fullPath));
						await fse.writeFile(fullPath, entry.getData());
					}
				}

				// 删除原 zip 文件
				await fse.remove(zipFile);

				successCount++;
				const showRename = finalName !== internalName;
				const tail = showRename ? pc.dim(` (清理自 ${internalName})`) : "";
				console.log(
					`  ${brand.success("✓")} ${relativePath} → ${finalName}/${tail}`,
				);
			} catch (error) {
				const err = error as Error;
				errors.push(`${relativePath}: ${err.message}`);
				console.log(`  ${brand.error("✗")} ${relativePath} - ${err.message}`);
			}
		}

		s.stop();

		console.log();
		if (errors.length > 0) {
			outro(
				`${brand.success("✓")} 成功解压 ${successCount} 个，${brand.error(errors.length + " 个失败")}`,
			);
		} else {
			outro(`${brand.success("✓")} 已成功解压 ${successCount} 个 zip 文件`);
		}
	});
