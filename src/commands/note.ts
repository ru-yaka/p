import { intro, isCancel, outro, text } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

import {
	getProjectMeta,
	listProjects,
	projectExists,
	saveProjectMeta,
} from "../core/project";
import { filterProjects } from "../utils/project-search";
import { brand, printError, printInfo, printSuccess } from "../utils/ui";

function resolveProjectName(name: string): string | null {
	if (name === ".") {
		const currentDir = process.cwd();
		const projects = listProjects();
		const current = projects.find((p) => p.path === currentDir);
		return current?.name || null;
	}

	if (projectExists(name)) return name;

	const projects = listProjects();
	const filtered = filterProjects(projects, name);
	if (filtered.length === 1) return filtered[0].name;
	if (filtered.length > 1) {
		printError(`匹配到多个项目: ${filtered.map((p) => p.name).join(", ")}`);
		return null;
	}

	printError(`项目不存在: ${name}`);
	return null;
}

async function setNote(projectName: string, noteText?: string) {
	let note = noteText;

	if (!note && note !== "") {
		const meta = getProjectMeta(projectName);
		const existing = meta?.note || "";

		const result = await text({
			message: `输入备注 (${brand.primary(projectName)}):`,
			placeholder: "简要描述项目用途...",
			initialValue: existing,
		});

		if (isCancel(result)) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		note = (result as string).trim();
	}

	if (note === "") {
		saveProjectMeta(projectName, { note: undefined as unknown as string });
		printSuccess(`已清除 ${brand.primary(projectName)} 的备注`);
	} else {
		saveProjectMeta(projectName, { note });
		printSuccess(`已为 ${brand.primary(projectName)} 设置备注: ${pc.dim(note!)}`);
	}
}

async function clearNote(projectName: string) {
	saveProjectMeta(projectName, { note: undefined as unknown as string });
	printSuccess(`已清除 ${brand.primary(projectName)} 的备注`);
}

async function showNote(projectName: string) {
	const meta = getProjectMeta(projectName);
	const note = meta?.note;

	if (!note) {
		printInfo(`${brand.primary(projectName)} 没有备注`);
		return;
	}

	console.log();
	console.log(
		brand.primary(`  ${projectName}`) +
			pc.dim(": ") +
			pc.dim(note),
	);
	console.log();
}

export const noteCommand = new Command("note")
	.alias("notes")
	.description("管理项目备注")
	.argument("[project]", "项目名称或 . 表示当前目录")
	.argument("[text]", "备注内容")
	.option("-c, --clear", "清除备注")
	.action(async (project?: string, noteText?: string, options?: { clear?: boolean }) => {
		// p note — 无参数，显示当前项目备注
		if (!project) {
			const currentDir = process.cwd();
			const projects = listProjects();
			const current = projects.find((p) => p.path === currentDir);

			if (!current) {
				printError("当前目录不是 p 管理的项目");
				process.exit(1);
			}

			await showNote(current.name);
			return;
		}

		const projectName = resolveProjectName(project);
		if (!projectName) process.exit(1);

		if (options?.clear) {
			await clearNote(projectName);
			return;
		}

		await setNote(projectName, noteText);
	});
