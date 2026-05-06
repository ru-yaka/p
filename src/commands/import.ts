import { basename, resolve } from "node:path";
import { intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import {
	getProjectPath,
	projectExists,
	saveProjectMeta,
	validateProjectNameFormat,
} from "../core/project";
import { collectProjectFiles, copyFiles } from "../utils/files";
import { PROJECTS_DIR } from "../utils/paths";
import { bgOrange, brand, printError, printSuccess } from "../utils/ui";

export const importCommand = new Command("import")
	.alias("i")
		.description("导入外部项目到 p 管理")
	.argument("[path]", "要导入的项目路径（. 表示当前目录，省略则交互选择）")
	.action(async (inputPath?: string) => {
		let sourcePath: string;

		if (inputPath === ".") {
			sourcePath = process.cwd();
		} else if (!inputPath) {
			const result = await text({
				message: "输入要导入的项目路径:",
				placeholder: "/path/to/project",
				validate: (value) => {
					if (!value.trim()) return "路径不能为空";
				},
			});
			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}
			sourcePath = resolve((result as string).trim());
		} else {
			sourcePath = resolve(inputPath);
		}

		// 验证路径存在且是目录
		if (!fse.existsSync(sourcePath)) {
			printError(`路径不存在: ${sourcePath}`);
			process.exit(1);
		}

		const stat = await fse.stat(sourcePath);
		if (!stat.isDirectory()) {
			printError(`不是目录: ${sourcePath}`);
			process.exit(1);
		}

		// 检查是否已在 p 管理下
		if (sourcePath.startsWith(resolve(PROJECTS_DIR))) {
			printError("该项目已在 p 管理下，无需导入");
			process.exit(1);
		}

		// 自动检测项目名
		let projectName = basename(sourcePath);

		// 名称冲突处理
		if (projectExists(projectName)) {
			intro(bgOrange(" 导入项目 "));

			const result = await text({
				message: `项目名 "${projectName}" 已存在，请输入新名称:`,
				placeholder: `${projectName}-2`,
				validate: (value) => {
					const v = validateProjectNameFormat(value);
					if (!v.valid) return v.message;
				},
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			projectName = (result as string).trim();
		}

		// 最终名称验证
		const nameCheck = validateProjectNameFormat(projectName);
		if (!nameCheck.valid) {
			printError(nameCheck.message || "项目名称无效");
			process.exit(1);
		}

		intro(bgOrange(" 导入项目 "));

		// 收集源文件（排除依赖）
		const s = spinner();
		s.start("正在分析文件...");

		const { success, files, message } = await collectProjectFiles(sourcePath);

		if (!success) {
			s.stop("分析失败");
			printError(message || "无法获取文件列表");
			process.exit(1);
		}

		if (files.length === 0) {
			s.stop("没有文件");
			printError("未找到可导入的文件（可能全部被忽略规则排除）");
			process.exit(1);
		}

		s.stop(
			`${brand.success("✓")} 找到 ${brand.primary(files.length.toString())} 个文件`,
		);

		// 复制文件
		const targetPath = getProjectPath(projectName);
		const copySpinner = spinner();
		copySpinner.start("正在复制文件...");

		try {
			await copyFiles(sourcePath, targetPath, files);
			copySpinner.stop(
				`${brand.success("✓")} 已复制 ${files.length} 个文件`,
			);
		} catch (error) {
			copySpinner.stop("复制失败");
			printError((error as Error).message);
			process.exit(1);
		}

		// 保存元数据
		saveProjectMeta(projectName, {
			originalPath: sourcePath,
		});

		console.log();
		printSuccess(
			`已导入项目: ${brand.primary(projectName)}`,
		);
		console.log();
		console.log(pc.dim("  源路径: ") + pc.underline(sourcePath));
		console.log(pc.dim("  目标:   ") + pc.underline(targetPath));
		console.log(
			pc.dim("  提示:   ") + "下次用 " + brand.primary("p open") + pc.dim(" 打开时，可删除原始目录"),
		);
		console.log();
	});
