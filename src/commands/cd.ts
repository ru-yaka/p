import { outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

import {
	getProjectPath,
	listProjects,
	projectExists,
} from "../core/project";
import { liveSearch, CANCEL } from "../utils/live-search";
import { filterProjects, projectHint } from "../utils/project-search";
import { brand, printError, printInfo } from "../utils/ui";

export const cdCommand = new Command("cd")
	.alias("c")
	.description("切换到项目目录")
	.argument("[name]", "项目名称或搜索关键词")
	.action(async (name?: string) => {
		const projects = listProjects();

		if (projects.length === 0) {
			printInfo(`暂无项目，使用 ${brand.primary("p new")} 创建新项目`);
			return;
		}

		let projectName: string;

		if (!name) {
			const options = projects.map((p) => ({
				value: p.name,
				label: p.name,
				hint: projectHint(p),
			}));

			const result = await liveSearch({
				message: "选择项目:",
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
				multiSelect: false,
			});

			if (result === CANCEL) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}

			projectName = result[0];
		} else if (!projectExists(name)) {
			const filtered = filterProjects(projects, name);
			if (filtered.length === 1) {
				console.log(pc.dim("  匹配到: ") + brand.primary(filtered[0].name));
				projectName = filtered[0].name;
			} else if (filtered.length > 1) {
				console.log(pc.dim(`  匹配到 ${filtered.length} 个项目`));

				const options = projects.map((p) => ({
					value: p.name,
					label: p.name,
					hint: projectHint(p),
				}));

				const result = await liveSearch({
					message: "选择项目:",
					placeholder: "输入名称、模板或标签筛选",
					options,
					filterFn: (query: string) => {
						if (!query) return options;
						const f = filterProjects(projects, query);
						return f.map((p) => ({
							value: p.name,
							label: p.name,
							hint: projectHint(p),
						}));
					},
					initialQuery: name,
					multiSelect: false,
				});

				if (result === CANCEL) {
					outro(pc.dim("已取消"));
					process.exit(0);
				}

				projectName = result[0];
			} else {
				printError(`项目不存在: ${name}`);
				console.log(
					pc.dim("使用 ") + brand.primary("p ls") + pc.dim(" 查看所有项目"),
				);
				process.exit(1);
			}
		} else {
			projectName = name;
		}

		const projectPath = getProjectPath(projectName);
		const shell = process.env.SHELL || "/bin/bash";

		const s = spinner();
		s.start(`切换到: ${brand.primary(projectName)}`);
		s.stop(`${brand.success("✓")} ${brand.primary(projectName)}`);
		console.log();

		const proc = Bun.spawn([shell], {
			cwd: projectPath,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: { ...process.env },
		});

		const exitCode = await proc.exited;
		process.exit(exitCode);
	});
