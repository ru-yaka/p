import { dirname, join } from "node:path";
import fse from "fs-extra";
import { parse } from "yaml";
import type { Config } from "../types";
import {
	CONFIG_PATH,
	HOOKS_DIR,
	P_ROOT,
	PROJECTS_DIR,
	TEMPLATES_DIR,
} from "../utils/paths";

function deepMerge<T extends Record<string, any>>(base: T, override: T): T {
	const result = { ...base } as Record<string, any>;
	for (const key of Object.keys(override)) {
		const bVal = result[key];
		const oVal = override[key];
		if (
			typeof oVal === "object" && oVal !== null && !Array.isArray(oVal) &&
			typeof bVal === "object" && bVal !== null && !Array.isArray(bVal)
		) {
			result[key] = deepMerge(bVal, oVal);
		} else {
			result[key] = oVal;
		}
	}
	return result as T;
}

function getDefaultConfigPath(): string {
	const execPath = process.argv[1];
	if (!execPath) return "";
	return join(dirname(execPath), "config.yaml");
}

/**
 * 确保 p 目录结构已初始化
 */
export async function ensureInitialized(): Promise<void> {
	const dirs = [P_ROOT, PROJECTS_DIR, TEMPLATES_DIR, HOOKS_DIR];
	for (const dir of dirs) {
		await fse.ensureDir(dir);
	}

	// 只在用户配置不存在时才复制默认配置（首次安装）
	if (!(await fse.pathExists(CONFIG_PATH))) {
		const defaultConfigPath = getDefaultConfigPath();
		if (await fse.pathExists(defaultConfigPath)) {
			await fse.copyFile(defaultConfigPath, CONFIG_PATH);
		}
	}
}

/**
 * 读取配置文件（智能合并：默认配置为基础，用户配置覆盖）
 */
export function loadConfig(): Config {
	if (!fse.existsSync(CONFIG_PATH)) {
		throw new Error("配置文件不存在，请运行 p config 创建配置文件");
	}

	try {
		const userContent = fse.readFileSync(CONFIG_PATH, "utf-8");
		const userConfig = parse(userContent) || {};

		// 读取默认配置，合并新增的 keys
		let defaultConfig = {};
		const defaultConfigPath = getDefaultConfigPath();
		if (defaultConfigPath && fse.existsSync(defaultConfigPath)) {
			const defaultContent = fse.readFileSync(defaultConfigPath, "utf-8");
			defaultConfig = parse(defaultContent) || {};
		}

		return deepMerge(defaultConfig, userConfig) as Config;
	} catch (error) {
		throw new Error(`配置文件解析失败: ${(error as Error).message}`);
	}
}
