import { intro, isCancel, multiselect, outro } from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import { listProjects } from "../core/project";
import { runHooksByKeys } from "../core/hooks";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

export const runCommand = new Command("run")
	.alias("r")
		.description("在当前项目执行 hooks")
	.argument("[hooks...]", "要执行的 hook 名称")
	.action(async (hookKeys: string[]) => {
		const config = loadConfig();
		const currentDir = process.cwd();
		const projects = listProjects();
		const currentProject = projects.find((p) => p.path === currentDir);

		if (!currentProject) {
			printError("当前目录不是 p 管理的项目");
			console.log(
				pc.dim("  请在项目目录中运行，或使用 ") +
					brand.primary("p open") +
					pc.dim(" 打开项目"),
			);
			process.exit(1);
		}

		const allHookKeys = Object.keys(config.hooks);
		if (allHookKeys.length === 0) {
			printInfo("暂无可用 hooks");
			console.log(
				pc.dim("  在 ") +
					brand.primary("~/.p/config.yaml") +
					pc.dim(" 中配置 hooks"),
			);
			return;
		}

		// 参数模式：直接执行指定 hooks
		if (hookKeys.length > 0) {
			// 验证 hook 是否存在
			const invalid = hookKeys.filter((k) => !config.hooks[k]);
			if (invalid.length > 0) {
				printError(`未知的 hook: ${invalid.join(", ")}`);
				console.log(
					pc.dim(`  可用 hooks: ${allHookKeys.join(", ")}`),
				);
				process.exit(1);
			}

			await runHooksByKeys(
				config,
				hookKeys,
				currentDir,
				currentProject.name,
			);

			console.log();
			console.log(
				brand.success("✓") +
					pc.dim(` 已在 ${brand.primary(currentProject.name)} 执行 ${hookKeys.length} 个 hook`),
			);
			return;
		}

		// 交互模式：多选 hooks
		intro(bgOrange(` 运行 Hooks · ${currentProject.name} `));

		const result = await multiselect({
			message: "选择要执行的 hooks:",
			options: allHookKeys.map((key) => ({
				value: key,
				label: config.hooks[key].name,
				hint: key,
			})),
			required: true,
		});

		if (isCancel(result)) {
			outro(pc.dim("已取消"));
			process.exit(0);
		}

		const selected = result as string[];
		await runHooksByKeys(config, selected, currentDir, currentProject.name);

		console.log();
		outro(brand.success(`✓ 已执行 ${selected.length} 个 hook`));
	});
