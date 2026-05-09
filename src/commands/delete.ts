import {
	confirm,
	intro,
	isCancel,
	multiselect,
	outro,
	spinner,
} from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import {
	clearAllProjectMeta,
	deleteProjectMeta,
	getProjectPath,
	listProjects,
	projectExists,
} from "../core/project";
import { liveSearch, CANCEL } from "../utils/live-search";
import {
	filterProjects,
	projectHint,
} from "../utils/project-search";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

/**
 * 搜索并选择要删除的项目（实时搜索）
 */
async function searchAndSelectDelete(
	projects: ReturnType<typeof listProjects>,
	initialQuery?: string,
): Promise<string> {
	const options = projects.map((p) => ({
		value: p.name,
		label: p.name,
		hint: projectHint(p),
	}));

	const result = await liveSearch({
		message: "搜索要删除的项目:",
		placeholder: "输入名称、模板或标签筛选",
		options,
		filterFn: (query: string) => {
			if (!query) return options;
			const filtered = filterProjects(projects, query);
			return filtered.map((p) => ({
				value: p.name,
				label: p.name,
				hint: projectHint(p),
			}));
		},
		initialQuery,
		selectAllLabel: "全选删除",
	});

	if (result === CANCEL) {
		outro(pc.dim("已取消"));
		process.exit(0);
	}

	return result as string[];
}

/**
 * 通配符匹配项目名
 */
function wildcardMatch(projects: ReturnType<typeof listProjects>, pattern: string): string[] {
	const regexStr = `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
	const regex = new RegExp(regexStr, "i");
	return projects.filter((p) => regex.test(p.name)).map((p) => p.name);
}

/**
 * 批量删除项目
 */
async function batchDelete(projectNames: string[]) {
	if (projectNames.length === 0) {
		printInfo("没有匹配的项目");
		return;
	}

	console.log();
	console.log(pc.dim("  将要删除的项目:"));
	for (const name of projectNames) {
		console.log(`  ${brand.secondary("•")} ${name}`);
	}
	console.log();

	const shouldDelete = await confirm({
		message: `确定要删除 ${brand.primary(String(projectNames.length))} 个项目吗？此操作不可恢复！`,
		initialValue: true,
	});

	if (isCancel(shouldDelete) || !shouldDelete) {
		outro(pc.dim("已取消"));
		process.exit(0);
	}

	console.log();
	const s = spinner();
	s.start("正在删除项目...");

	const results = await Promise.allSettled(
		projectNames.map(async (name, index) => {
			try {
				await fse.remove(getProjectPath(name));
				return { success: true, name, index };
			} catch (error) {
				const err = error as Error;
				return { success: false, name, error: err.message, index };
			}
		}),
	);

	s.stop();

	console.log();
	let deletedCount = 0;
	const errors: string[] = [];

	for (const result of results) {
		if (result.status === "fulfilled") {
			const r = result.value;
			if (r.success) {
				deletedCount++;
				deleteProjectMeta(r.name);
				console.log(
					`  ${brand.success("✓")} [${r.index + 1}/${projectNames.length}] ${r.name}`,
				);
			} else {
				errors.push(`${r.name}: ${r.error}`);
				console.log(
					`  ${brand.error("✗")} [${r.index + 1}/${projectNames.length}] ${r.name} - ${r.error}`,
				);
			}
		}
	}

	console.log();
	if (errors.length > 0) {
		outro(
			`${brand.success("✓")} 已删除 ${deletedCount} 个项目，${errors.length} 个失败`,
		);
	} else {
		outro(`${brand.success("✓")} 已成功删除 ${deletedCount} 个项目`);
	}
}

export const deleteCommand = new Command("delete")
	.alias("d")
	.alias("rm")
	.description("删除项目")
	.argument("[name]", "项目名称、通配符模式，或 'all'")
	.action(async (name?: string) => {
		const projects = listProjects();

		if (projects.length === 0) {
			console.log();
			printInfo("暂无项目");
			console.log();
			return;
		}

		// 处理 delete all 命令
		if (name === "all") {
			intro(bgOrange(" 删除所有项目 "));

			console.log();
			console.log(pc.dim("  将要删除的项目:"));
			for (const project of projects) {
				const templateInfo = project?.template
					? pc.cyan(` (${project.template})`)
					: "";
				console.log(`  ${brand.secondary("•")} ${project.name}${templateInfo}`);
			}
			console.log();

			// 确认删除
			const shouldDelete = await confirm({
				message: `确定要删除 ${brand.primary(String(projects.length))} 个项目吗？此操作不可恢复！`,
				initialValue: true,
			});

			if (isCancel(shouldDelete) || !shouldDelete) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			console.log();
			const s = spinner();
			s.start("正在删除项目...");

			// 并发删除所有项目
			const results = await Promise.allSettled(
				projects.map(async (project, index) => {
					try {
						await fse.remove(project.path);
						return { success: true, project, index };
					} catch (error) {
						const err = error as Error;
						return { success: false, project, error: err.message, index };
					}
				}),
			);

			s.stop();

			// 统计结果并显示
			console.log();
			let deletedCount = 0;
			const errors: string[] = [];

			// 按索引排序结果以保持显示顺序
			const sortedResults = results
				.map((result, idx) => ({ result, originalIndex: idx }))
				.sort((a, b) => {
					const aIndex =
						a.result.status === "fulfilled"
							? a.result.value.index
							: a.originalIndex;
					const bIndex =
						b.result.status === "fulfilled"
							? b.result.value.index
							: b.originalIndex;
					return aIndex - bIndex;
				});

			for (const { result } of sortedResults) {
				if (result.status === "fulfilled") {
					if (result.value.success) {
						deletedCount++;
						console.log(
							`  ${brand.success("✓")} [${result.value.index + 1}/${projects.length}] ${result.value.project.name}`,
						);
					} else {
						errors.push(`${result.value.project.name}: ${result.value.error}`);
						console.log(
							`  ${brand.error("✗")} [${result.value.index + 1}/${projects.length}] ${result.value.project.name} - ${result.value.error}`,
						);
					}
				} else {
					errors.push(`删除失败: ${result.reason}`);
				}
			}

			// 清除所有元数据
			clearAllProjectMeta();

			console.log();
			if (errors.length > 0) {
				outro(
					`${brand.success("✓")} 已删除 ${deletedCount} 个项目，${errors.length} 个失败`,
				);
			} else {
				outro(`${brand.success("✓")} 已成功删除所有 ${deletedCount} 个项目`);
			}

			return;
		}

		// 通配符模式
		if (name && name.includes("*")) {
			let matched = wildcardMatch(projects, name);

			if (matched.length === 0) {
				// 去掉通配符，用关键词模糊搜索
				const keyword = name.replace(/\*/g, "");
				const similar = keyword
					? filterProjects(projects, keyword).map((p) => p.name)
					: [];

				if (similar.length === 0) {
					printError(`没有匹配 '${name}' 的项目`);
					process.exit(1);
				}

				printError(`没有匹配 '${name}' 的项目`);
				console.log();
				console.log(pc.dim("  是否删除以下项目？"));
				for (const n of similar) {
					console.log(`    ${brand.secondary("•")} ${n}`);
				}
				console.log();

				const shouldDelete = await confirm({
					message: `删除这 ${brand.primary(String(similar.length))} 个项目？`,
					initialValue: true,
				});

				if (isCancel(shouldDelete) || !shouldDelete) {
					outro(pc.dim("已取消"));
					process.exit(0);
				}

				matched = similar;
			}

			intro(bgOrange(" 批量删除 "));
			await batchDelete(matched);
			return;
		}

		// 无参数 → 多选模式
		if (!name) {
			intro(bgOrange(" 批量删除 "));

			const result = await multiselect({
				message: "选择要删除的项目（空格选择）:",
				options: projects.map((p) => ({
					value: p.name,
					label: p.name,
					hint: projectHint(p),
				})),
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			const selected = result as string[];
			await batchDelete(selected);
			return;
		}

		// 搜索删除
		let projectNames: string[];

		if (projectExists(name)) {
			projectNames = [name];
		} else {
			const filtered = filterProjects(projects, name);
			if (filtered.length === 0) {
				printError(`项目不存在: ${name}`);
				console.log(
					pc.dim("使用 ") + brand.primary("p ls") + pc.dim(" 查看所有项目"),
				);
				process.exit(1);
			}
			projectNames = await searchAndSelectDelete(projects, name);
		}

		if (projectNames.length > 1) {
			intro(bgOrange(" 批量删除 "));
			await batchDelete(projectNames);
			return;
		}

		const projectName = projectNames[0];
		const projectPath = getProjectPath(projectName);

		// 确认删除
		const shouldDelete = await confirm({
			message: `确定要删除项目 ${brand.primary(projectName)} 吗？此操作不可恢复！`,
			initialValue: true,
		});

		if (isCancel(shouldDelete) || !shouldDelete) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		const s = spinner();
		s.start(`正在删除 ${projectName}...`);

		try {
			await fse.remove(projectPath);
			deleteProjectMeta(projectName);
			s.stop(`${brand.success("✓")} 已删除: ${brand.primary(projectName)}`);
		} catch (error) {
			s.stop("删除失败");
			const err = error as Error;
			printError(err.message);
			process.exit(1);
		}
	});
