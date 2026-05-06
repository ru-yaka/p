import { intro, isCancel, multiselect, outro, text } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

import {
	getProjectMeta,
	listProjects,
	projectExists,
	saveProjectMeta,
} from "../core/project";
import { bgOrange, brand, printError, printInfo, printSuccess } from "../utils/ui";

/**
 * 获取当前目录对应的项目名
 */
function getCurrentProjectName(): string | null {
	const currentDir = process.cwd();
	const projects = listProjects();
	const current = projects.find((p) => p.path === currentDir);
	return current?.name || null;
}

async function addTags(tags: string[]) {
	const projectName = getCurrentProjectName();
	if (!projectName) {
		printError("当前目录不是 p 管理的项目");
		process.exit(1);
	}

	let tagList = tags.map((t) => t.toLowerCase());

	if (tagList.length === 0) {
		const result = await text({
			message: "输入标签（空格分隔）:",
			placeholder: "react typescript web",
		});
		if (isCancel(result)) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}
		tagList = (result as string)
			.split(/[\s,，]+/)
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean);
	}

	if (tagList.length === 0) {
		printInfo("未提供标签");
		return;
	}

	const meta = getProjectMeta(projectName);
	const existing = meta?.tags || [];
	const merged = [...new Set([...existing, ...tagList])];
	const added = merged.filter((t) => !existing.includes(t));

	saveProjectMeta(projectName, { tags: merged });

	if (added.length > 0) {
		printSuccess(
			`已为 ${brand.primary(projectName)} 添加标签: ${added.map((t) => pc.magenta(`#${t}`)).join(" ")}`,
		);
	} else {
		printInfo("标签已存在，无新增");
	}
}

async function removeTags(tags: string[]) {
	const projectName = getCurrentProjectName();
	if (!projectName) {
		printError("当前目录不是 p 管理的项目");
		process.exit(1);
	}

	const meta = getProjectMeta(projectName);
	const existing = meta?.tags || [];

	if (existing.length === 0) {
		printInfo(`${brand.primary(projectName)} 没有标签`);
		return;
	}

	let toRemove: string[];

	if (tags.length === 0) {
		// 只有一个标签 → 直接移除
		if (existing.length === 1) {
			saveProjectMeta(projectName, { tags: [] });
			printSuccess(
				`已从 ${brand.primary(projectName)} 移除标签: ${pc.magenta(`#${existing[0]}`)}`,
			);
			return;
		}

		intro(bgOrange(" 移除标签 "));

		const result = await multiselect({
			message: "按空格选择要移除的标签:",
			options: existing.map((t) => ({
				value: t,
				label: `#${t}`,
			})),
		});

		if (isCancel(result)) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		toRemove = result as string[];
	} else {
		toRemove = tags.map((t) => t.toLowerCase());
	}

	if (toRemove.length === 0) {
		printInfo("未选择标签");
		return;
	}

	const remaining = existing.filter((t) => !toRemove.includes(t));
	saveProjectMeta(projectName, { tags: remaining });

	printSuccess(
		`已从 ${brand.primary(projectName)} 移除标签: ${toRemove.map((t) => pc.magenta(`#${t}`)).join(" ")}`,
	);
}

async function listAllTags() {
	const projects = listProjects();
	const tagged = projects.filter((p) => p.tags && p.tags.length > 0);

	if (tagged.length === 0) {
		printInfo("暂无标签");
		return;
	}

	const allTags = new Map<string, string[]>();
	for (const p of tagged) {
		for (const tag of p.tags!) {
			if (!allTags.has(tag)) allTags.set(tag, []);
			allTags.get(tag)!.push(p.name);
		}
	}

	console.log();
	console.log(brand.primary("  🏷️ 标签列表"));
	console.log(pc.dim("  ─".repeat(20)));
	console.log();

	for (const [tag, projectNames] of allTags) {
		console.log(
			"  " + pc.magenta(`#${tag}`) + pc.dim(` (${projectNames.length})`),
		);
		for (const name of projectNames) {
			console.log(pc.dim(`    ${name}`));
		}
		console.log();
	}
}

async function showCurrentTags() {
	const projectName = getCurrentProjectName();
	if (!projectName) {
		printError("当前目录不是 p 管理的项目");
		process.exit(1);
	}

	const meta = getProjectMeta(projectName);
	const tags = meta?.tags || [];

	if (tags.length === 0) {
		printInfo(`${brand.primary(projectName)} 没有标签`);
		return;
	}

	console.log();
	console.log(
		brand.primary(`  ${projectName}`) +
			pc.dim(":") +
			" " +
			tags.map((t) => pc.magenta(`#${t}`)).join(" "),
	);
	console.log();
}

export const tagCommand = new Command("tag")
	.alias("t")
	.alias("tags")
	.description("管理当前项目标签")
	.action(async () => {
		// p tag — 无参数，显示当前项目标签
		await showCurrentTags();
	})
	.addCommand(
		new Command("add")
			.description("添加标签到当前项目")
			.argument("[tags...]", "标签名称（空格分隔）")
			.action(async (tags?: string[]) => {
				await addTags(tags || []);
			}),
	)
	.addCommand(
		new Command("rm")
			.alias("remove")
			.description("移除当前项目标签")
			.argument("[tags...]", "标签名称")
			.action(async (tags?: string[]) => {
				await removeTags(tags || []);
			}),
	)
	.addCommand(
		new Command("ls")
			.alias("list")
			.description("列出所有标签")
			.action(async () => {
				await listAllTags();
			}),
	);
