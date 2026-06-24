import { Command } from "commander";
import pc from "picocolors";

import { getProjectPath, listProjects, projectExists } from "../core/project";
import { filterProjects, projectHint } from "../utils/project-search";
import { brand, printError } from "../utils/ui";

export const pathCommand = new Command("path")
	.alias("p")
	.alias("pp")
	.description("打印项目绝对路径（支持模糊匹配）")
	.argument("<name>", "项目名称或搜索关键词")
	.action((name: string) => {
		const projects = listProjects();

		if (projects.length === 0) {
			printError("暂无项目");
			process.exit(1);
		}

		let projectName: string;

		if (projectExists(name)) {
			projectName = name;
		} else {
			const filtered = filterProjects(projects, name);
			if (filtered.length === 0) {
				printError(`项目不存在: ${name}`);
				console.error(
					pc.dim("使用 ") + brand.primary("p ls") + pc.dim(" 查看所有项目"),
				);
				process.exit(1);
			}
			if (filtered.length > 1) {
				printError(`匹配到 ${filtered.length} 个项目，请精确指定:`);
				for (const p of filtered) {
					console.error(`  ${brand.secondary("•")} ${p.name} ${projectHint(p)}`);
				}
				process.exit(1);
			}
			projectName = filtered[0].name;
		}

		process.stdout.write(`${getProjectPath(projectName)}\n`);
	});
