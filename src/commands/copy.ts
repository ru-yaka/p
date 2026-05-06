import { basename, resolve } from "node:path";
import { intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import {
	getProjectPath,
	projectExists,
	saveProjectMeta,
	validateProjectNameFormat,
} from "../core/project";
import { execAndCapture, openWithIDE } from "../utils/shell";
import { bgOrange, brand, printError } from "../utils/ui";

export const copyCommand = new Command("copy")
	.alias("cp")
	.description("复制目录作为新项目到 p 管理")
	.argument("<path>", "要复制的目录路径（支持相对/绝对路径）")
	.argument("[name]", "自定义项目名称（默认从路径推断）")
	.action(async (inputPath: string, customName?: string) => {
		const config = loadConfig();

		// 解析源路径
		const sourcePath = resolve(inputPath);

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

		// 确定项目名
		let projectName = customName || basename(sourcePath);

		// 名称验证
		const nameCheck = validateProjectNameFormat(projectName);
		if (!nameCheck.valid) {
			printError(nameCheck.message || "项目名称无效");
			process.exit(1);
		}

		// 冲突检查
		if (projectExists(projectName)) {
			intro(bgOrange(" 复制目录 "));

			const result = await text({
				message: `项目名 "${projectName}" 已存在，请输入新名称:`,
				placeholder: `${projectName}-2`,
				validate: (value) => {
					const v = validateProjectNameFormat(value);
					if (!v.valid) return v.message;
					if (projectExists(value)) return "项目已存在";
					return undefined;
				},
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			projectName = (result as string).trim();
		} else {
			intro(bgOrange(" 复制目录 "));
		}

		console.log();
		console.log(pc.dim("  源路径:   ") + pc.underline(sourcePath));
		console.log(pc.dim("  项目名:   ") + brand.primary(projectName));
		console.log();

		const targetPath = getProjectPath(projectName);

		// 复制目录
		const s = spinner();
		s.start("正在复制目录...");

		try {
			await fse.copy(sourcePath, targetPath, { overwrite: true });
			s.stop(`${brand.success("✓")} 目录已复制`);
		} catch (error) {
			s.stop("复制失败");
			printError((error as Error).message);
			process.exit(1);
		}

		// 初始化 git
		const gitSpinner = spinner();
		gitSpinner.start("正在初始化 git...");

		const gitResult = await execAndCapture("git init", targetPath);

		if (!gitResult.success) {
			gitSpinner.stop("git init 失败");
			console.log(pc.dim(gitResult.error));
		} else {
			gitSpinner.stop(`${brand.success("✓")} git 已初始化`);
		}

		// 保存元数据
		saveProjectMeta(projectName, { template: "copy" });

		// 打开 IDE
		const ideSpinner = spinner();
		ideSpinner.start(`正在用 ${config.ide} 打开 ${projectName}...`);

		try {
			await openWithIDE(config.ide, targetPath);
			ideSpinner.stop(
				`${brand.success("✓")} 已打开: ${brand.primary(projectName)}`,
			);
		} catch (error) {
			ideSpinner.stop(`打开 ${config.ide} 失败`);
			console.log();
			printError((error as Error).message);
			console.log();
			console.log(pc.dim("  项目路径: ") + pc.underline(targetPath));
			console.log();
		}

		outro(brand.success("✨ 项目复制成功！"));
	});
