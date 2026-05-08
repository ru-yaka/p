import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { listProjects } from "../core/project";
import { getLocalTemplates } from "../core/template";
import { loadConfig } from "../core/config";
import { TEMPLATES_DIR } from "../utils/paths";
import { brand, formatRelativeTime, printInfo } from "../utils/ui";

async function listTemplates() {
	if (!(await fse.pathExists(TEMPLATES_DIR))) {
		console.log();
		printInfo(`暂无模板，使用 ${brand.primary("p templates add")} 添加模板`);
		console.log();
		return;
	}

	const localTemplates = await getLocalTemplates();
	const entries = Object.values(localTemplates);

	if (entries.length === 0) {
		console.log();
		printInfo(`暂无模板，使用 ${brand.primary("p templates add")} 添加模板`);
		console.log();
		return;
	}

	console.log();
	console.log(
		brand.primary("  📦 模板列表") + pc.dim(` (${entries.length} 个)`),
	);
	console.log(pc.dim("  ─".repeat(20)));
	console.log();

	for (const tpl of entries) {
		console.log(
			"  " +
				brand.secondary("◆") +
				" " +
				brand.bold(tpl.name),
		);
		console.log(pc.dim(`    ${TEMPLATES_DIR}/${tpl.dir || tpl.name}`));
		console.log();
	}

	console.log(
		pc.dim("  提示: 使用 ") +
			brand.primary("p templates add") +
			pc.dim(" 添加模板"),
	);
	console.log();
}

export const lsCommand = new Command("ls")
	.alias("list")
	.description("列出所有项目")
	.argument("[filter]", "templates / t 列出模板")
	.action(async (filter?: string) => {
		if (filter === "templates" || filter === "t") {
			await listTemplates();
			return;
		}

		const projects = listProjects();

		if (projects.length === 0) {
			console.log();
			printInfo(`暂无项目，使用 ${brand.primary("p new")} 创建新项目`);
			console.log();
			return;
		}

		console.log();
		console.log(
			brand.primary("  📂 项目列表") + pc.dim(` (${projects.length} 个)`),
		);
		console.log(pc.dim("  ─".repeat(20)));
		console.log();

		for (const project of projects) {
			const timeStr = formatRelativeTime(project.modifiedAt);
			const templateTag = project.template
				? ` ${pc.cyan(`[${project.template}]`)}`
				: "";
			const tagDisplay =
				project.tags && project.tags.length > 0
					? ` ${project.tags.map((t) => pc.magenta(`#${t}`)).join(" ")}`
					: "";
			const noteDisplay = project.note
				? ` ${pc.dim(`— ${project.note}`)}`
				: "";

			console.log(
				"  " +
					brand.secondary("◆") +
					" " +
					brand.bold(project.name) +
					templateTag +
					tagDisplay +
					noteDisplay +
					pc.dim(`  ${timeStr}`),
			);
			console.log(pc.dim(`    ${project.path}`));
			console.log();
		}

		console.log(
			pc.dim("  提示: 使用 ") + brand.primary("p open") + pc.dim(" 打开项目"),
		);
		console.log();
	});
