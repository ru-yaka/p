import { basename, resolve } from "node:path";
import { intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import { getProjectMeta, getProjectPath, listProjects, projectExists } from "../core/project";
import { collectProjectFiles, copyFiles } from "../utils/files";
import { liveSearch, CANCEL } from "../utils/live-search";
import { TEMPLATES_DIR } from "../utils/paths";
import { openWithIDE } from "../utils/shell";
import { filterProjects } from "../utils/project-search";
import { bgOrange, brand, printError, printInfo, printSuccess } from "../utils/ui";

/**
 * 检查模板是否存在
 */
async function templateExists(templateName: string): Promise<boolean> {
	const templatePath = resolve(TEMPLATES_DIR, templateName);
	return fse.pathExists(templatePath);
}

/**
 * 构建模板 add 的搜索选项
 */
function buildTemplateOptions(projects: ReturnType<typeof listProjects>) {
	return projects.map((p) => ({
		value: p.name,
		label: p.name,
		hint: p.template ? pc.cyan(p.template) : undefined,
	}));
}

export const templateCommand = new Command("template")
	.alias("templates")
	.description("管理本地模板")
	.argument("[action]", "操作: add, update")
	.argument("[target]", "项目名称或 . 表示当前目录")
	.argument("[name]", "模板名称")
	.action(async (action?: string, target?: string, name?: string) => {
		// 如果没有提供 action，则打开 templates 目录
		if (!action) {
			const config = loadConfig();

			// 确保 templates 目录存在
			await fse.ensureDir(TEMPLATES_DIR);

			const s = spinner();
			s.start(`正在用 ${config.ide} 打开模板目录...`);

			try {
				await openWithIDE(config.ide, TEMPLATES_DIR);
				s.stop(
					`${brand.success("✓")} 已打开模板目录: ${brand.primary(TEMPLATES_DIR)}`,
				);
			} catch (error) {
				s.stop("打开失败");
				console.log();
				printError((error as Error).message);
				console.log();
				console.log(pc.dim("  模板目录: ") + pc.underline(TEMPLATES_DIR));
				console.log();
				process.exit(1);
			}

			return;
		}

		// 处理 add 操作
		if (action === "add") {
			await handleAdd(target, name);
		} else if (action === "update") {
			await handleUpdate(target);
		} else {
			printError(`未知操作: ${action}`);
			console.log(pc.dim("  支持的操作: add, update"));
			process.exit(1);
		}
	});

async function handleAdd(target?: string, templateNameArg?: string) {
	const currentDir = process.cwd();
	const projects = listProjects();
	const currentProject = projects.find((p) => p.path === currentDir);

	// 如果没有指定目标，且当前目录是项目，默认使用当前项目
	if (!target && currentProject) {
		const templateName = templateNameArg || currentProject.template || currentProject.name;
		const isUpdate = !!currentProject.template;

		// 检查模板是否已存在
		const exists = await templateExists(templateName);
		if (exists && !isUpdate) {
			printInfo(`模板 ${brand.primary(templateName)} 已存在，将更新`);
		}

		await createOrUpdateTemplate(currentDir, templateName, isUpdate || exists);
		return;
	}

	// 处理当前目录（显式指定 .）
	if (target === ".") {
		let templateName: string | null = null;
		let isUpdate = false;

		if (templateNameArg) {
			templateName = templateNameArg;
			const exists = await templateExists(templateName);
			isUpdate = exists;
		} else if (currentProject?.template) {
			templateName = currentProject.template;
			isUpdate = true;
		} else {
			const defaultName = currentProject?.name || basename(currentDir);
			const result = await text({
				message: "请输入模板名称:",
				placeholder: defaultName,
				defaultValue: defaultName,
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			templateName = (result as string).trim() || defaultName;
		}

		const exists = await templateExists(templateName);
		if (exists && !isUpdate) {
			printInfo(`模板 ${brand.primary(templateName)} 已存在，将更新`);
		}

		await createOrUpdateTemplate(currentDir, templateName, isUpdate || exists);
		return;
	}

	// 处理项目名称

	if (projects.length === 0) {
		console.log();
		printInfo(`暂无项目，使用 ${brand.primary("p new")} 创建新项目`);
		console.log();
		return;
	}


	let selectedProject = target;
	const options = buildTemplateOptions(projects);

	// 如果没有提供项目名，实时搜索选择
	if (!selectedProject) {
		const result = await liveSearch({
			message: "搜索要添加为模板的项目:",
			placeholder: "输入项目名称筛选",
			options,
			filterFn: (query: string) => {
				if (!query) return options;
				const filtered = filterProjects(projects, query);
				return filtered.map((p) => ({
					value: p.name,
					label: p.name,
					hint: p.template ? pc.cyan(p.template) : undefined,
				}));
			},
		});

		if (result === CANCEL) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		selectedProject = result as string;
	} else {
		// 验证项目是否存在，不存在则模糊匹配
		if (!projectExists(selectedProject)) {
			const filtered = filterProjects(projects, selectedProject);
			if (filtered.length === 1) {
				selectedProject = filtered[0].name;
			} else if (filtered.length > 1) {
				// 多个匹配 → 实时搜索，预填关键词
				const result = await liveSearch({
					message: "搜索要添加为模板的项目:",
					placeholder: "输入项目名称筛选",
					options,
					filterFn: (query: string) => {
						if (!query) return options;
						const f = filterProjects(projects, query);
						return f.map((p) => ({
							value: p.name,
							label: p.name,
							hint: p.template ? pc.cyan(p.template) : undefined,
						}));
					},
					initialQuery: selectedProject,
				});
				if (isCancel(result)) {
					outro(pc.dim("已取消"));
					process.exit(0);
				}
				selectedProject = result as string;
			} else {
				printError(`项目不存在: ${selectedProject}`);
				console.log(
					pc.dim("使用 ") + brand.primary("p ls") + pc.dim(" 查看所有项目"),
				);
				process.exit(1);
			}
		}
	}

	const sourcePath = getProjectPath(selectedProject);

	// 检查项目是否有关联的模板
	const project = projects.find((p) => p.name === selectedProject);
	const templateName = templateNameArg || project?.template || selectedProject;
	const isUpdate = !!project?.template;

	await createOrUpdateTemplate(sourcePath, templateName, isUpdate);
}

async function handleUpdate(target?: string) {
	const currentDir = process.cwd();
	const projects = listProjects();
	const currentProject = projects.find((p) => p.path === currentDir);

	// 如果没有指定目标，且当前目录是项目，默认更新当前项目的模板
	if (!target && currentProject?.template) {
		await createOrUpdateTemplate(currentDir, currentProject.template, true);
		return;
	}

	// 处理当前目录（显式指定 .）
	if (target === ".") {
		if (!currentProject?.template) {
			printError("当前项目没有关联模板");
			console.log(
				pc.dim("  使用 ") +
					brand.primary("p templates add .") +
					pc.dim(" 添加为模板"),
			);
			process.exit(1);
		}

		await createOrUpdateTemplate(currentDir, currentProject.template, true);
		return;
	}

	// 如果没有指定目标，列出可更新的模板
	const localTemplates = await fse.readdir(TEMPLATES_DIR).catch(() => []);
	const updatableTemplates: string[] = [];

	for (const name of localTemplates) {
		const templatePath = resolve(TEMPLATES_DIR, name);
		const stat = await fse.stat(templatePath);
		if (stat.isDirectory()) {
			updatableTemplates.push(name);
		}
	}

	if (updatableTemplates.length === 0) {
		printInfo("暂无可更新的模板");
		console.log(
			pc.dim("  使用 ") +
				brand.primary("p templates add <project>") +
				pc.dim(" 添加模板"),
		);
		return;
	}

	intro(bgOrange(" 更新模板 "));

	const result = await select({
		message: "请选择要更新的模板:",
		options: updatableTemplates.map((name) => ({
			value: name,
			label: name,
		})),
	});

	if (isCancel(result)) {
		outro(pc.dim("已取消"));
		process.exit(0);
	}

	const selectedTemplate = result as string;
	const templatePath = resolve(TEMPLATES_DIR, selectedTemplate);

	// 查找使用该模板的项目
	const allProjects = listProjects();
	const project = allProjects.find((p) => p.template === selectedTemplate);

	if (project) {
		await createOrUpdateTemplate(project.path, selectedTemplate, true);
	} else {
		printError(`找不到使用模板 ${selectedTemplate} 的项目`);
		console.log(
			pc.dim("  模板目录: ") + pc.underline(templatePath),
		);
		process.exit(1);
	}
}

async function createOrUpdateTemplate(
	sourcePath: string,
	templateName: string,
	isUpdate: boolean,
) {
	intro(isUpdate ? bgOrange(" 更新模板 ") : bgOrange(" 添加模板 "));

	// 获取需要复制的文件
	const s = spinner();
	s.start("正在分析文件...");

	const { success, files, message } = await collectProjectFiles(sourcePath);

	if (!success) {
		s.stop("分析失败");
		console.log();
		printError(message || "无法获取文件列表");
		console.log();
		process.exit(1);
	}

	s.stop(
		`${brand.success("✓")} 找到 ${brand.primary(files.length.toString())} 个文件`,
	);

	// 复制文件
	const targetPath = resolve(TEMPLATES_DIR, templateName);

	const copySpinner = spinner();
	copySpinner.start(
		isUpdate ? "正在更新模板..." : "正在复制文件到模板目录...",
	);

	try {
		// 如果是更新，先清空目标目录
		if (isUpdate) {
			await fse.emptyDir(targetPath);
		}
		await copyFiles(sourcePath, targetPath, files);

		copySpinner.stop(
			`${brand.success("✓")} 模板${isUpdate ? "已更新" : "已创建"}: ${brand.primary(templateName)}`,
		);
	} catch (error) {
		copySpinner.stop("操作失败");
		console.log();
		printError((error as Error).message);
		console.log();
		process.exit(1);
	}

	console.log();
	outro(
		brand.success(
			`✓ 模板${isUpdate ? "更新" : "添加"}成功: ${brand.primary(templateName)}`,
		),
	);
	console.log();
	console.log(pc.dim("  模板位置: ") + pc.underline(targetPath));
	console.log();
}
