import { intro, isCancel, outro, spinner } from "@clack/prompts";
import { Command } from "commander";
import fse from "fs-extra";
import pc from "picocolors";

import { loadConfig } from "../core/config";
import {
	getProjectPath,
	listProjects,
	projectExists,
	saveProjectMeta,
} from "../core/project";
import { commandExists, execAndCapture, execInDir } from "../utils/shell";
import { liveSearch, CANCEL } from "../utils/live-search";
import { filterProjects, projectHint } from "../utils/project-search";
import { PROJECTS_DIR } from "../utils/paths";
import { bgOrange, brand, printError, printInfo } from "../utils/ui";

const SYNC_EXCLUDES = [
	"node_modules",
	".next",
	".nuxt",
	".output",
	"dist",
	"build",
	"coverage",
	".git",
	".vscode",
	".idea",
	"*.log",
	".DS_Store",
	"Thumbs.db",
];

async function searchAndSelect(
	projects: ReturnType<typeof listProjects>,
	initialQuery?: string,
): Promise<string> {
	const options = projects.map((p) => ({
		value: p.name,
		label: p.name,
		hint: projectHint(p),
	}));

	const result = await liveSearch({
		message: "搜索要同步的项目:",
		placeholder: "输入项目名称筛选",
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
	});

	if (result === CANCEL) {
		outro(pc.dim("已取消"));
		process.exit(0);
	}

	return (result as string[])[0];
}

function buildRsyncArgs(
	source: string,
	dest: string,
	excludes: string[],
	port: number,
	dryRun: boolean,
): string {
	const parts = ["rsync", "-avz", "--progress"];

	for (const pattern of excludes) {
		parts.push(`--exclude '${pattern}'`);
	}

	if (dryRun) {
		parts.push("--dry-run");
	}

	if (port !== 22) {
		parts.push(`-e "ssh -p ${port}"`);
	}

	parts.push(`${source}/`, dest);

	return parts.join(" ");
}

export const syncCommand = new Command("sync")
	.description("在局域网机器间同步项目")
	.argument("[name]", "项目名称或搜索关键词")
	.option("--push", "推送项目到远程机器")
	.option("--pull", "从远程机器拉取项目")
	.option("--dry-run", "预览将要同步的文件（不实际传输）")
	.action(
		async (
			name?: string,
			options?: { push?: boolean; pull?: boolean; dryRun?: boolean },
		) => {
			const opts = options || {};

			// 校验参数
			const directionCount =
				(opts.push ? 1 : 0) + (opts.pull ? 1 : 0);
			if (directionCount !== 1) {
				printError("请指定 --push 或 --pull 其中之一");
				console.log(
					pc.dim("  用法: p sync <项目名> --push / --pull"),
				);
				process.exit(1);
			}

			// 检查依赖
			if (!(await commandExists("rsync"))) {
				printError("rsync 未安装");
				console.log(
					pc.dim("  安装: sudo apt install rsync 或 brew install rsync"),
				);
				process.exit(1);
			}
			if (!(await commandExists("ssh"))) {
				printError("ssh 未安装");
				console.log(
					pc.dim("  安装: sudo apt install openssh-client"),
				);
				process.exit(1);
			}

			// 读取配置
			const config = loadConfig();
			if (!config.sync?.remote) {
				printError("未配置同步远程地址");
				console.log(
					pc.dim(
						`  请在 ~/.p/config.yaml 中添加:\n  sync:\n    remote: "user@192.168.1.100"`,
					),
				);
				process.exit(1);
			}

			const remote = config.sync.remote;
			const port = config.sync.port || 22;
			const extraExcludes = config.sync.exclude || [];
			const excludes = [...SYNC_EXCLUDES, ...extraExcludes];

			// SSH 连通性测试
			const connSpinner = spinner();
			connSpinner.start(`正在连接 ${remote}...`);
			const sshArgs =
				port !== 22 ? `-o ConnectTimeout=5 -p ${port}` : "-o ConnectTimeout=5";
			const connTest = await execAndCapture(
				`ssh ${sshArgs} ${remote} "echo ok"`,
				process.cwd(),
			);
			if (!connTest.success) {
				connSpinner.stop("连接失败");
				console.log();
				printError(`无法连接到 ${remote}`);
				console.log(pc.dim("  请检查地址、网络和 SSH 密钥配置"));
				process.exit(1);
			}
			connSpinner.stop(`${brand.success("✓")} 已连接: ${brand.primary(remote)}`);

			// 解析远程主目录
			const homeResult = await execAndCapture(
				`ssh ${sshArgs} ${remote} "echo ~"`,
				process.cwd(),
			);
			const remoteHome = homeResult.success
				? homeResult.output.trim()
				: "~";
			const remoteProjectsDir = `${remoteHome}/.p/projects`;

			// 项目选择
			const projects = listProjects();
			let projectName = name;

			if (projectName) {
				if (opts.push && !projectExists(projectName)) {
					const filtered = filterProjects(projects, projectName);
					if (filtered.length === 1) {
						console.log(
							pc.dim("  匹配到: ") +
								brand.primary(filtered[0].name),
						);
						projectName = filtered[0].name;
					} else if (filtered.length > 1) {
						console.log(
							pc.dim(`  匹配到 ${filtered.length} 个项目`),
						);
						projectName = await searchAndSelect(
							projects,
							projectName,
						);
					} else {
						printError(`项目不存在: ${projectName}`);
						process.exit(1);
					}
				} else if (opts.pull && !projectExists(projectName)) {
					// pull 时本地可能不存在，直接用输入的名字
				}
			} else {
				if (projects.length === 0 && opts.push) {
					printInfo("暂无项目");
					return;
				}
				if (projects.length > 0) {
					projectName = await searchAndSelect(projects);
				} else {
					printError("请指定项目名称");
					process.exit(1);
				}
			}

			const localPath = getProjectPath(projectName);
			const remotePath = `${remote}:${remoteProjectsDir}/${projectName}`;

			const direction = opts.push ? "推送" : "拉取";
			const label = opts.push ? "推送" : "拉取";

			intro(bgOrange(` ${label}项目 `));
			console.log(
				pc.dim(`  ${direction}: `) + brand.primary(projectName),
			);
			console.log(
				pc.dim("  目标: ") + pc.underline(remotePath),
			);
			console.log();

			if (opts.push) {
				// push: 确保远程 projects 目录存在
				await execAndCapture(
					`ssh ${sshArgs} ${remote} "mkdir -p ${remoteProjectsDir}"`,
					process.cwd(),
				);
			} else {
				// pull: 确保本地目录存在
				await fse.ensureDir(localPath);

				// 检查远程项目是否存在
				const checkResult = await execAndCapture(
					`ssh ${sshArgs} ${remote} "test -d ${remoteProjectsDir}/${projectName} && echo exists || echo missing"`,
					process.cwd(),
				);
				if (
					!checkResult.success ||
					checkResult.output.trim() !== "exists"
				) {
					printError(
						`远程项目 '${projectName}' 不存在，请先使用 --push 推送`,
					);
					process.exit(1);
				}
			}

			// 构建 rsync 命令
			const source = opts.push ? localPath : remotePath;
			const dest = opts.push ? remotePath : localPath;

			const rsyncCmd = buildRsyncArgs(
				source,
				dest,
				excludes,
				port,
				!!opts.dryRun,
			);

			if (opts.dryRun) {
				console.log(pc.dim("  预览模式，不会实际传输文件"));
				console.log();
			}

			const syncSpinner = spinner();
			syncSpinner.start(
				opts.dryRun
					? `正在预览${direction}文件...`
					: `正在${direction}文件...`,
			);

			// 停掉 spinner 让 rsync 输出直接显示
			syncSpinner.stop(
				`${brand.success("✓")} rsync ${direction}中...`,
			);

			const result = await execInDir(rsyncCmd, process.cwd(), {
				silent: true,
			});

			console.log();

			if (!result.success) {
				printError(`${direction}失败`);
				if (result.stderr) {
					console.log(pc.dim(result.stderr));
				}
				process.exit(1);
			}

			// pull 成功后，如果是新项目则保存元数据
			if (opts.pull && !projectExists(projectName)) {
				saveProjectMeta(projectName, { template: "sync" });
			}

			outro(
				brand.success(
					`✓ ${projectName} ${direction}完成`,
				),
			);
		},
	);
