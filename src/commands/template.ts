import { resolve } from "node:path";
import { confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import { getProjectMeta, getProjectPath, listProjects, projectExists, saveProjectMeta } from "../core/project";
import { collectProjectFiles, copyFiles } from "../utils/files";
import { liveSearch, CANCEL } from "../utils/live-search";
import { TEMPLATES_DIR } from "../utils/paths";
import { commandExists, execAndCapture, execInDir, openWithIDE } from "../utils/shell";
import { filterProjects } from "../utils/project-search";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

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
		hint: p.savedTemplate ? pc.cyan(p.savedTemplate) : undefined,
	}));
}

export const templateCommand = new Command("template")
	.alias("templates")
	.alias("tp")
	.description("管理本地模板")
	.argument("[action]", "操作: add, update, publish")
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
		} else if (action === "publish") {
			await handlePublish(target);
		} else {
			printError(`未知操作: ${action}`);
			console.log(pc.dim("  支持的操作: add, update, publish"));
			process.exit(1);
		}
	});

async function handleAdd(target?: string, templateNameArg?: string) {
	const currentDir = process.cwd();
	const projects = listProjects();
	const currentProject = projects.find((p) => p.path === currentDir);

	// 如果没有指定目标，且当前目录是项目，默认使用当前项目
	if (!target && currentProject) {
		const templateName = await resolveTemplateName(currentProject, templateNameArg);
		if (!templateName) return;
		await createOrUpdateTemplate(currentDir, templateName, !!currentProject.savedTemplate && currentProject.savedTemplate === templateName);
		saveSavedTemplate(currentProject.name, templateName);
		return;
	}

	// 处理当前目录（显式指定 .）
	if (target === ".") {
		const templateName = await resolveTemplateName(currentProject, templateNameArg);
		if (!templateName) return;
		await createOrUpdateTemplate(currentDir, templateName, !!currentProject?.savedTemplate && currentProject.savedTemplate === templateName);
		if (currentProject) saveSavedTemplate(currentProject.name, templateName);
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
					hint: p.savedTemplate ? pc.cyan(p.savedTemplate) : undefined,
				}));
			},
		});

		if (result === CANCEL) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		selectedProject = (result as string[])[0];
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
							hint: p.savedTemplate ? pc.cyan(p.savedTemplate) : undefined,
						}));
					},
					initialQuery: selectedProject,
				});
				if (isCancel(result)) {
					outro(pc.dim("已取消"));
					process.exit(0);
				}
				selectedProject = (result as string[])[0];
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
	const project = projects.find((p) => p.name === selectedProject);
	const templateName = await resolveTemplateName(project, templateNameArg);
	if (!templateName) return;
	await createOrUpdateTemplate(sourcePath, templateName, !!project?.savedTemplate && project.savedTemplate === templateName);
	if (project) saveSavedTemplate(project.name, templateName);
}

/**
 * 保存 savedTemplate 到项目元数据
 */
function saveSavedTemplate(projectName: string, templateName: string): void {
	saveProjectMeta(projectName, { savedTemplate: templateName });
}

/**
 * 解析模板名称：
 * 1. 如果提供了名称参数 → 直接使用
 * 2. 如果项目已保存为模板 → 提示是否更新该模板
 * 3. 否则 → 要求输入模板名称
 */
async function resolveTemplateName(
	project: { name: string; savedTemplate?: string } | undefined,
	templateNameArg?: string,
): Promise<string | null> {
	// 指定了名称参数
	if (templateNameArg) {
		return templateNameArg;
	}

	// 项目已保存为模板 → 询问是否更新
	if (project?.savedTemplate) {
		console.log(
			pc.dim("  当前项目已保存为模板: ") + brand.primary(project.savedTemplate),
		);
		console.log(
			pc.dim("  下次可直接运行: ") +
				brand.primary(`p templates update .`),
		);
		console.log();

		const shouldUpdate = await confirm({
			message: `是否更新模板 ${project.savedTemplate}？`,
		});

		if (isCancel(shouldUpdate) || !shouldUpdate) {
			outro(pc.dim("已取消"));
			return null;
		}

		return project.savedTemplate;
	}

	// 没有关联模板 → 要求输入名称
	const result = await text({
		message: "请输入模板名称:",
		placeholder: "my-template",
	});

	if (isCancel(result)) {
		outro(pc.dim("已取消"));
		return null;
	}

	const name = (result as string).trim();
	if (!name) {
		printError("模板名称不能为空");
		return null;
	}

	return name;
}

async function handleUpdate(target?: string) {
	const currentDir = process.cwd();
	const projects = listProjects();
	const currentProject = projects.find((p) => p.path === currentDir);

	// 如果没有指定目标，且当前目录是项目，默认更新当前项目的模板
	if (!target && currentProject?.savedTemplate) {
		await createOrUpdateTemplate(currentDir, currentProject.savedTemplate, true);
		return;
	}

	// 处理当前目录（显式指定 .）
	if (target === ".") {
		if (!currentProject?.savedTemplate) {
			printError("当前项目没有关联模板");
			console.log(
				pc.dim("  使用 ") +
					brand.primary("p templates add . <名称>") +
					pc.dim(" 添加为模板"),
			);
			process.exit(1);
		}

		await createOrUpdateTemplate(currentDir, currentProject.savedTemplate, true);
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
	const project = allProjects.find((p) => p.savedTemplate === selectedTemplate);

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

async function handlePublish(nameArg?: string) {
	// 处理 "publish ." —— 当前项目发布为模板
	if (nameArg === ".") {
		const currentDir = process.cwd();
		const projects = listProjects();
		const currentProject = projects.find((p) => p.path === currentDir);

		let templateName: string;
		let needSave = false;

		if (currentProject?.savedTemplate) {
			// 已关联模板 → 询问是否更新
			templateName = currentProject.savedTemplate;
			printInfo(`当前项目已关联模板: ${brand.primary(templateName)}`);
			const shouldUpdate = await confirm({ message: "是否更新模板？" });
			if (isCancel(shouldUpdate)) {
				outro(pc.dim("已取消"));
				return;
			}
			if (shouldUpdate) needSave = true;
		} else {
			// 未关联 → 输入名称并创建
			const result = await text({
				message: "请输入模板名称:",
				placeholder: "my-template",
			});
			if (isCancel(result) || !(result as string).trim()) {
				outro(pc.dim("已取消"));
				return;
			}
			templateName = (result as string).trim();
			needSave = true;
		}

		if (needSave) {
			await createOrUpdateTemplate(currentDir, templateName, await templateExists(templateName));
			if (currentProject) saveSavedTemplate(currentProject.name, templateName);
		}

		await doPublish(templateName);
		return;
	}

	await fse.ensureDir(TEMPLATES_DIR);
	const entries = await fse.readdir(TEMPLATES_DIR).catch(() => []);
	const localTemplates: string[] = [];

	for (const entry of entries) {
		const stat = await fse.stat(resolve(TEMPLATES_DIR, entry));
		if (stat.isDirectory()) localTemplates.push(entry);
	}

	if (localTemplates.length === 0) {
		printInfo("暂无本地模板");
		console.log(
			pc.dim("  使用 ") +
				brand.primary("p templates add <project>") +
				pc.dim(" 添加模板"),
		);
		return;
	}

	let selectedTemplate: string;

	if (nameArg) {
		const lower = nameArg.toLowerCase();
		const matched = localTemplates.filter((t) => t.toLowerCase().includes(lower));
		if (matched.length === 1) {
			selectedTemplate = matched[0];
		} else if (matched.length > 1) {
			printError(`多个模板匹配 "${nameArg}": ${matched.join(", ")}`);
			process.exit(1);
		} else {
			printError(`模板不存在: ${nameArg}`);
			process.exit(1);
		}
	} else {
		const options = localTemplates.map((name) => ({
			value: name,
			label: name,
		}));

		const result = await liveSearch({
			message: "选择要发布的模板:",
			placeholder: "输入模板名称筛选",
			options,
			filterFn: (query: string) => {
				if (!query) return options;
				return options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
			},
		});

		if (result === CANCEL) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		selectedTemplate = (result as string[])[0];
	}

	await doPublish(selectedTemplate);
}

async function doPublish(selectedTemplate: string) {
	const templatePath = resolve(TEMPLATES_DIR, selectedTemplate);
	intro(bgOrange(" 发布模板 "));

	const shouldPublish = await confirm({
		message: `确认将模板 ${brand.primary(selectedTemplate)} 发布到 GitHub？`,
	});
	if (isCancel(shouldPublish) || !shouldPublish) {
		outro(pc.dim("已取消"));
		return;
	}

	if (!(await commandExists("gh"))) {
		printError("需要安装 GitHub CLI (gh)");
		console.log(pc.dim("  https://cli.github.com/"));
		process.exit(1);
	}

	const authCheck = await execAndCapture("gh auth status", process.cwd());
	if (!authCheck.success) {
		printError("请先登录 GitHub CLI: gh auth login");
		process.exit(1);
	}

	const s = spinner();
	s.start("正在创建 GitHub 仓库...");

	const repoResult = await execAndCapture(
		`gh repo create ${selectedTemplate} --public --description "p template: ${selectedTemplate}"`,
		process.cwd(),
	);

	if (!repoResult.success) {
		s.stop("创建仓库失败");
		console.log();
		printError(repoResult.error || repoResult.output || "未知错误");
		console.log();
		process.exit(1);
	}

	const urlMatch = (repoResult.output || repoResult.error).match(/https:\/\/github\.com\/([^/]+)\/[^\s/]+/);
	if (!urlMatch) {
		s.stop("解析仓库地址失败");
		console.log();
		printError(repoResult.output || repoResult.error);
		console.log();
		process.exit(1);
	}

	const owner = urlMatch[1];
	const cloneUrl = `https://github.com/${owner}/${selectedTemplate}.git`;
	s.stop(`${brand.success("✓")} 仓库已创建: ${brand.primary(`${owner}/${selectedTemplate}`)} (public)`);

	const pushSpinner = spinner();
	pushSpinner.start("正在推送文件...");

	const initResult = await execInDir("git init", templatePath, { silent: true });
	if (!initResult.success) {
		pushSpinner.stop("git init 失败");
		console.log();
		printError(initResult.stderr || initResult.output);
		console.log();
		await cleanupGitDir(templatePath);
		process.exit(1);
	}

	await execInDir("git add -A", templatePath, { silent: true });
	await execInDir('git commit -m "init: p template"', templatePath, { silent: true });

	const pushResult = await execInDir(
		"git push -u origin main",
		templatePath,
		{ silent: true },
	);

	if (!pushResult.success) {
		const masterResult = await execInDir(
			"git branch -M master && git push -u origin master",
			templatePath,
			{ silent: true },
		);
		if (!masterResult.success) {
			pushSpinner.stop("推送失败");
			console.log();
			printError(masterResult.stderr || masterResult.output);
			console.log();
			await cleanupGitDir(templatePath);
			process.exit(1);
		}
	}

	await cleanupGitDir(templatePath);

	const fileCount = await countFiles(templatePath);
	pushSpinner.stop(`${brand.success("✓")} 已推送 ${brand.primary(fileCount.toString())} 个文件`);

	console.log();
	console.log(pc.dim("  克隆链接: ") + pc.underline(cloneUrl));
	console.log();
}

async function cleanupGitDir(dir: string) {
	const gitDir = resolve(dir, ".git");
	if (await fse.pathExists(gitDir)) {
		await fse.remove(gitDir);
	}
}

async function countFiles(dir: string): Promise<number> {
	let count = 0;
	const entries = await fse.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		if (entry.isDirectory()) {
			count += await countFiles(resolve(dir, entry.name));
		} else {
			count++;
		}
	}
	return count;
}
