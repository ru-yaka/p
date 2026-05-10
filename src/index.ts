#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addCommand } from "./commands/add";
import { cloneCommand } from "./commands/clone";
import { configCommand } from "./commands/config";
import { copyCommand } from "./commands/copy";
import { deleteCommand } from "./commands/delete";
import { hookCommand } from "./commands/hook";
import { importCommand } from "./commands/import";
import { lsCommand } from "./commands/ls";
import { metaCommand } from "./commands/meta";
import { newCommand } from "./commands/new";
import { noteCommand } from "./commands/note";
import { openCommand } from "./commands/open";
import { projectCommand } from "./commands/project";
import { renameCommand } from "./commands/rename";
import { recentCommand } from "./commands/recent";
import { runCommand } from "./commands/run";
import { tagCommand } from "./commands/tag";
import { templateCommand } from "./commands/template";
import { unzipCommand } from "./commands/unzip";
import { updateCommand } from "./commands/update";
import { ensureInitialized } from "./core/config";
import { brand } from "./utils/ui";

// 读取版本号
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const program = new Command();

// 确保首次运行时初始化
await ensureInitialized();

program
	.name("p")
	.description(`${brand.primary("⚡ P")} v${pkg.version} — 项目管理工具`)
	.version(pkg.version);

// 显示所有 alias，而非仅第一个
const Help = (await import("commander")).Help;
Help.prototype.subcommandTerm = function (cmd: any) {
	const aliases = cmd.aliases();
	if (aliases.length === 0) return cmd.name();
	return `${cmd.name()}|${aliases.join("|")}`;
};

// 注册子命令
program.addCommand(addCommand);
program.addCommand(cloneCommand);
program.addCommand(copyCommand);
program.addCommand(newCommand);
program.addCommand(lsCommand);
program.addCommand(openCommand);
program.addCommand(deleteCommand);
program.addCommand(renameCommand);
program.addCommand(recentCommand);
program.addCommand(projectCommand);
program.addCommand(runCommand);
program.addCommand(importCommand);
program.addCommand(tagCommand);
program.addCommand(templateCommand);
program.addCommand(configCommand);
program.addCommand(hookCommand);
program.addCommand(metaCommand);
program.addCommand(noteCommand);
program.addCommand(unzipCommand);
program.addCommand(updateCommand);

program.parse();
