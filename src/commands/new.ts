import { confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import { runHooks } from "../core/hooks";
import {
	getProjectPath,
	listProjects,
	projectExists,
	saveProjectMeta,
	validateProjectName,
} from "../core/project";
import {
	applyTemplate,
	getAllTemplates,
	getTemplateChoices,
} from "../core/template";
import { commandExists, execAndCapture, execInDir, openWithIDE } from "../utils/shell";
import { PROJECTS_DIR, CONFIG_PATH } from "../utils/paths";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";
import { LLMError, generateProjectNames } from "../utils/llm";
import { selectOrInput, CANCEL } from "../utils/select-or-input";

const REGENERATE = Symbol("regenerate");

export const newCommand = new Command("new")
	.alias("n")
		.alias("create")
	.description("创建新项目")
	.argument("[name]", "项目名称（支持 #tag 添加标签）")
	.option("-t, --template [template]", "使用指定模板")
	.option("-d, --desc <text>", "用描述生成项目名（AI 命名）")
	.option("--debug", "AI 调试模式")
		.allowExcessArguments(true)
		.action(
			async (
				name?: string,
				options?: { template?: string | boolean; desc?: string; debug?: boolean },
			) => {
			// 检测 p new -- <command> 模式
			const rawArgs = process.argv;
			const ddIdx = rawArgs.indexOf("--");
			const newIdx = rawArgs.lastIndexOf("new");

			if (ddIdx !== -1 && ddIdx > newIdx) {
				let cmd = rawArgs.slice(ddIdx + 1).join(" ");
				if (!cmd) {
					printError("-- 后需要提供命令");
					process.exit(1);
				}

				// 检测别名：第一个 token 匹配 config.shortcuts
				const config = loadConfig();
				const tokens = rawArgs.slice(ddIdx + 1);
				const alias = config.shortcuts?.[tokens[0]];
				if (alias) {
					const remaining = tokens.slice(1).join(" ");
					cmd = remaining ? `${alias} ${remaining}` : alias;
					console.log();
					console.log(pc.dim("  别名: ") + brand.primary(tokens[0]) + pc.dim(` → ${alias}`));
					console.log(pc.dim("  配置: ") + pc.underline(CONFIG_PATH));
				}

				console.log();
				console.log(pc.dim("  工作目录: ") + pc.underline(PROJECTS_DIR));
				console.log();

				await fse.ensureDir(PROJECTS_DIR);

				const existingProjects = new Set(
					listProjects().map((p) => p.name),
				);

				const result = await execInDir(cmd, PROJECTS_DIR, { captureStderr: true });

				if (!result.success) {
					// GitHub API rate limit recovery
					if (
						!process.env.GITHUB_TOKEN &&
						result.stderr?.toLowerCase().includes("rate limit") &&
						(await commandExists("gh"))
					) {
						const retry = await confirm({
							message:
								"检测到 GitHub API 速率限制，是否使用当前 gh auth 的 token 重试？",
						});

						if (!isCancel(retry) && retry) {
							const tokenResult = await execAndCapture("gh auth token", process.cwd());
							if (tokenResult.success && tokenResult.output) {
								const token = tokenResult.output.trim();
								process.env.GITHUB_TOKEN = token;

								// 很多工具（如 create-expo-app）不读 GITHUB_TOKEN，
								// 通过 NODE_OPTIONS 注入 fetch patch 给 api.github.com 请求加 auth
								const patchFile = join(tmpdir(), "p-github-auth-patch.cjs");
								fse.writeFileSync(
									patchFile,
									`const _f=globalThis.fetch;globalThis.fetch=async(u,o={})=>{const s=typeof u==="string"?u:u?.url||"";if(s.includes("api.github.com"))o={...o,headers:{...o.headers,Authorization:"Bearer "+process.env.GITHUB_TOKEN}};return _f(u,o)};`,
								);
								const prevNodeOpts = process.env.NODE_OPTIONS || "";
								process.env.NODE_OPTIONS =
									prevNodeOpts +
									` --require ${patchFile.replace(/\\/g, "/")}`;

								console.log();
								console.log(pc.dim("  已注入 GITHUB_TOKEN，正在重试..."));
								console.log();
								const retryResult = await execInDir(cmd, PROJECTS_DIR);

								process.env.NODE_OPTIONS = prevNodeOpts || undefined;
								try { fse.unlinkSync(patchFile); } catch {}

								if (!retryResult.success) {
									console.log();
									printError("重试仍然失败");
									process.exit(1);
								}
							} else {
								console.log();
								printError("获取 gh auth token 失败");
								process.exit(1);
							}
						} else {
							console.log();
							printError("命令执行失败");
							process.exit(1);
						}
					} else {
						console.log();
						printError("命令执行失败");
						process.exit(1);
					}
				}

				// 扫描新项目目录并注册
				const entries = await fse.readdir(PROJECTS_DIR, { withFileTypes: true });
				const newProjects: string[] = [];

				for (const entry of entries) {
					if (entry.isDirectory() && !existingProjects.has(entry.name)) {
						saveProjectMeta(entry.name, {});
						newProjects.push(entry.name);
					}
				}

				console.log();
				if (newProjects.length > 0) {
						const config = loadConfig();
						for (const n of newProjects) {
							console.log(
								`  ${brand.success("✓")} 已注册项目: ${brand.primary(n)}`,
							);
						}

						// 用 IDE 打开第一个新项目
						const firstProject = getProjectPath(newProjects[0]);
						const s = spinner();
						s.start(`正在打开 ${config.ide}...`);
						try {
							await openWithIDE(config.ide, firstProject);
							s.stop(`${config.ide} 已打开`);
						} catch (error) {
							s.stop("打开失败");
							printError((error as Error).message);
						}
					} else {
						printInfo("未检测到新项目目录");
					}

					return;
				}

				const config = loadConfig();
			const allTemplates = await getAllTemplates(config.templates);

		// 从名称参数中提取 #tag（如 p new myproj #clone #pnpm）
		const nameParts = (name || "").split(/\s+/);
		const tags = nameParts
			.filter((p) => p.startsWith("#"))
			.map((t) => t.slice(1).toLowerCase());
		const cleanName = nameParts.filter((p) => !p.startsWith("#")).join(" ") || name;

		// 快速模式：只有项目名，没有 -t / --desc 参数 → 使用 empty 模板
		const isQuickMode = cleanName && !options?.template && !options?.desc;

		if (isQuickMode) {
			// 验证项目名称
			const validation = validateProjectName(cleanName);
			if (!validation.valid) {
				printError(validation.message!);
				process.exit(1);
			}

			const projectPath = getProjectPath(cleanName);

			// 创建空目录
			try {
				await fse.ensureDir(projectPath);
			} catch (error) {
				const err = error as Error;
				printError(err.message);
				process.exit(1);
			}

			// 执行 empty 模板的 hooks
			const emptyTemplate = config.templates.empty;

			if (emptyTemplate?.hooks && emptyTemplate.hooks.length > 0) {
				await runHooks(config, "empty", projectPath, cleanName);
			}

			// 保存项目元数据
			saveProjectMeta(cleanName, { template: "empty", tags });

			// 打开 IDE
			try {
				await openWithIDE(config.ide, projectPath);
				console.log(
					brand.success("✓") +
						" " +
						brand.primary(name) +
						pc.dim(" 已创建并打开"),
				);
			} catch (error) {
				console.log();
				printError((error as Error).message);
				console.log();
				console.log(pc.dim("  项目路径: ") + pc.underline(projectPath));
				console.log();
			}
			return;
		}

		// 交互模式
		intro(bgOrange(" 创建新项目 "));

		// 1. 获取项目名称
		let projectName = cleanName;

		// AI 命名模式
		if (options?.desc) {
			// Debug 模式：只输出调试信息，不进入选择流程
			if (options?.debug) {
				await generateProjectNames(options.desc, { debug: true });
				return;
			}

			try {
				const allGenerated: string[] = [];
				let suggestions: string[] = [];
				let linesPrinted = 0;

				const generateNames = async () => {
					// 清除之前的建议
					if (linesPrinted > 0) {
						process.stdout.write(`\x1b[${linesPrinted}A`);
						for (let i = 0; i < linesPrinted; i++) {
							process.stdout.write("\x1b[2K\n");
						}
						process.stdout.write(`\x1b[${linesPrinted}A`);
					}

					console.log(
						`  ${brand.secondary("◆")} ${pc.dim("AI 命名建议")}`,
					);
					linesPrinted = 1;

					const result = await generateProjectNames(options.desc!, {
						onName: (name) => {
							console.log(
								`  ${brand.secondary("│")} ${brand.primary(name)}`,
							);
							linesPrinted++;
						},
						exclude: allGenerated,
					});

					suggestions = result as string[];
					allGenerated.push(...suggestions);
				};

				await generateNames();

				// 选择循环
				for (;;) {
					// 清除建议块
					if (linesPrinted > 0) {
						process.stdout.write(`\x1b[${linesPrinted}A`);
						for (let i = 0; i < linesPrinted; i++) {
							process.stdout.write("\x1b[2K\n");
						}
						process.stdout.write(`\x1b[${linesPrinted}A`);
						linesPrinted = 0;
					}

					// 构建选项
					const selectOptions = [
						...suggestions.map((n) => ({ value: n, label: n })),
						{ value: "__regenerate__", label: pc.cyan("换一批"), hint: "重新生成" },
					];

					const choice = await selectOrInput({
						message: "选择项目名称:",
						options: selectOptions,
						placeholder: "直接输入自定义名称...",
						validate: (value) => {
							const validation = validateProjectName(value);
							if (!validation.valid) return validation.message;
						},
					});

					if (choice === CANCEL) {
						outro(pc.dim("已取消"));
						process.exit(0);
					}

					if (choice === "__regenerate__") {
						await generateNames();
						continue;
					}

					projectName = choice as string;
					break;
				}
			} catch (error) {
				if (error instanceof LLMError) {
					printError(error.message);
					process.exit(1);
				}
				throw error;
			}
		}

		if (!projectName) {
			const result = await text({
				message: "请输入项目名称:",
				placeholder: "my-awesome-project",
				validate: (value) => {
					const validation = validateProjectName(value);
					if (!validation.valid) return validation.message;
				},
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}
			projectName = result as string;
		} else {
			// 验证传入的名称
			const validation = validateProjectName(cleanName);
			if (!validation.valid) {
				printError(validation.message!);
				process.exit(1);
			}
		}

		// 2. 获取模板
		let templateKey: string;
		const templateChoices = getTemplateChoices(allTemplates);

		if (options?.template === true || options?.template === "") {
			// -t 没有值，显示选择菜单
			const result = await select({
				message: "请选择项目模板:",
				options: templateChoices,
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}
			templateKey = result as string;
		} else if (options?.template) {
			// -t 有值
			templateKey = options.template;
			if (!allTemplates[templateKey]) {
				// 模糊匹配
				const q = templateKey.toLowerCase();
				const keys = Object.keys(allTemplates);
				const matched = keys.filter(
					(k) => k.toLowerCase().includes(q),
				);

				if (matched.length === 1) {
					templateKey = matched[0];
				} else if (matched.length > 1) {
					const result = await select({
						message: `模板 '${options.template}' 匹配到多个:`,
						options: matched.map((k) => ({
							value: k,
							label: allTemplates[k].name,
						})),
					});
					if (isCancel(result)) {
						outro(pc.dim("已取消"));
						process.exit(0);
					}
					templateKey = result as string;
				} else {
					printError(`模板不存在: ${templateKey}`);
					console.log(
						pc.dim(`可用模板: ${keys.join(", ")}`),
					);
					process.exit(1);
				}
			}
		} else {
			// 没有 -t 参数但进入了交互模式（没有项目名）
			const result = await select({
				message: "请选择项目模板:",
				options: templateChoices,
			});

			if (isCancel(result)) {
				outro(pc.dim("已取消"));
				process.exit(0);
			}
			templateKey = result as string;
		}

		const template = allTemplates[templateKey];
		if (!template) {
			printError(`模板不存在: ${templateKey}`);
			process.exit(1);
		}

		const projectPath = getProjectPath(projectName);

		// 3. 显示信息
		console.log();
		console.log(pc.dim("  项目名称: ") + brand.primary(projectName));
		console.log(pc.dim("  使用模板: ") + brand.secondary(template.name));
		console.log(pc.dim("  项目路径: ") + pc.dim(projectPath));

		// 4. 创建项目目录
		try {
			await fse.ensureDir(projectPath);
		} catch (error) {
			const err = error as Error;
			printError(err.message);
			process.exit(1);
		}

		// 5. 应用模板（显示命令和输出）
		const templateResult = await applyTemplate(template, projectPath);

		if (!templateResult.success) {
			// 模板应用失败，删除已创建的项目目录
			try {
				await fse.remove(projectPath);
			} catch {
				// 忽略删除失败的错误，继续显示模板应用失败的错误
			}
			printError(templateResult.message);
			process.exit(1);
		}

		// 6. 执行 hooks（显示命令和输出）
		await runHooks(config, templateKey, projectPath, projectName);

		// 7. 保存项目元数据
		saveProjectMeta(projectName, { template: templateKey, tags });

		// 8. 打开 IDE
		console.log();
		const s = spinner();
		s.start(`正在打开 ${config.ide}...`);
		try {
			await openWithIDE(config.ide, projectPath);
			s.stop(`${config.ide} 已打开`);
		} catch (error) {
			s.stop(`打开 ${config.ide} 失败`);
			console.log();
			printError((error as Error).message);
			console.log();
			console.log(pc.dim("  项目路径: ") + pc.underline(projectPath));
		}

		// 9. 完成
		outro(brand.success("✨ 项目创建成功！"));
	});
