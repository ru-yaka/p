import { intro, outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import AdmZip from "adm-zip";
import fse from "fs-extra";
import { glob } from "glob";
import pc from "picocolors";
import { basename, dirname, join, parse } from "node:path";
import { getProjectPath, projectExists } from "../core/project";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

export const unzipCommand = new Command("unzip")
	.description("解压项目中所有 zip 文件")
	.argument("[project]", "项目名称（. 或省略表示当前目录）")
	.action(async (project?: string) => {
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

		intro(bgOrange(" 解压 zip 文件 "));
		console.log();
		console.log(pc.dim(`  找到 ${zipFiles.length} 个 zip 文件:`));
		for (const file of zipFiles) {
			console.log(`  ${brand.secondary("•")} ${basename(file)}`);
		}
		console.log();

		const s = spinner();
		s.start("正在解压...");

		let successCount = 0;
		const errors: string[] = [];

		for (const zipFile of zipFiles) {
			const relativePath = basename(zipFile);
			try {
				const zipName = parse(zipFile).name;
				const destDir = join(dirname(zipFile), zipName);

				// 如果目标目录已存在，先删除
				if (await fse.pathExists(destDir)) {
					await fse.remove(destDir);
				}

				const zip = new AdmZip(zipFile);
				const entries = zip.getEntries();

				// 过滤 __MACOSX 和 .DS_Store
				const validEntries = entries.filter((entry) => {
					const name = entry.entryName;
					return !name.startsWith("__MACOSX") && !name.includes("/__MACOSX") && !name.endsWith(".DS_Store");
				});

				// 检查是否需要 flatten：如果所有条目都在同一个根目录下
				const rootDirs = new Set(
					validEntries
						.filter((e) => !e.isDirectory)
						.map((e) => e.entryName.split("/")[0]),
				);

				// 计算 flatten 偏移：如果唯一根目录名 == zip 文件名，跳过它
				let stripPrefix = "";
				if (rootDirs.size === 1 && [...rootDirs][0] === zipName) {
					stripPrefix = zipName + "/";
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
				console.log(`  ${brand.success("✓")} ${relativePath} → ${zipName}/`);
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
