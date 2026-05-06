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
	.option("-f, --flatten", "解散 zip 内的根目录")
	.action(async (project?: string, options?: { flatten?: boolean }) => {
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

				// 使用 adm-zip 解压到临时目录
				const tempDir = `${destDir}.tmp`;
				const zip = new AdmZip(zipFile);
				zip.extractAllTo(tempDir, true);

				// 检查是否需要解散根目录
				if (options?.flatten) {
					const entries = await fse.readdir(tempDir);
					// 如果只有一个目录且没有其他文件，解散它
					if (entries.length === 1) {
						const singleEntry = join(tempDir, entries[0]);
						const stat = await fse.stat(singleEntry);
						if (stat.isDirectory()) {
							// 把这个目录的内容移动到目标目录
							await fse.move(singleEntry, destDir);
							await fse.remove(tempDir);
						} else {
							// 单个文件，正常移动
							await fse.move(tempDir, destDir);
						}
					} else {
						// 多个条目，正常移动
						await fse.move(tempDir, destDir);
					}
				} else {
					await fse.move(tempDir, destDir);
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
