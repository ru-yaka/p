import pc from "picocolors";

import { loadConfig } from "../core/config";
import type { Config } from "../types";

export type Provider = "glm" | "deepseek";

interface ProviderSpec {
	name: string;
	apiUrl: string;
	defaultModel: string;
	envKey: string;
	configKey: keyof Config;
	docsUrl: string;
	extraBody?: Record<string, unknown>;
}

const PROVIDERS: Record<Provider, ProviderSpec> = {
	glm: {
		name: "智谱 GLM",
		apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
		defaultModel: "glm-4.7-flash",
		envKey: "ZHIPU_API_KEY",
		configKey: "apiKey",
		docsUrl: "https://open.bigmodel.cn/",
		extraBody: { thinking: { type: "disabled" } },
	},
	deepseek: {
		name: "DeepSeek",
		apiUrl: "https://api.deepseek.com/chat/completions",
		defaultModel: "deepseek-v4-flash",
		envKey: "DEEPSEEK_API_KEY",
		configKey: "deepseekApiKey",
		docsUrl: "https://api-docs.deepseek.com/",
	},
};

const DEFAULT_COUNT = 5;

const NAME_RULES = `规则：
- 只使用小写英文字母、数字和连字符
- 必须以字母开头
- 简洁、有意义、好记
- 优先使用 1-2 个词，尽量避免 3 个词
- 数字直接跟在单词后面，不要用连字符分隔（如 blog2 而非 blog-2）`;

export class LLMError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LLMError";
	}
}

export function getProviderName(p: Provider): string {
	return PROVIDERS[p].name;
}

function hasApiKey(provider: Provider, config: Config): boolean {
	const spec = PROVIDERS[provider];
	return !!(
		process.env[spec.envKey] || (config[spec.configKey] as string | undefined)
	);
}

function getApiKey(provider: Provider, config: Config): string | null {
	const spec = PROVIDERS[provider];
	const envKey = process.env[spec.envKey];
	if (envKey) return envKey;
	const configVal = config[spec.configKey] as string | undefined;
	return configVal || null;
}

/**
 * 构建 provider 优先级链：providers > provider > 自动推断（按已配 key，DeepSeek 优先）
 */
function buildProviderChain(config: Config): Provider[] {
	// 1. 显式 providers 列表（过滤没 key 的）
	if (config.ai?.providers && config.ai.providers.length > 0) {
		return config.ai.providers.filter((p) => hasApiKey(p, config));
	}
	// 2. 显式单 provider
	if (config.ai?.provider && hasApiKey(config.ai.provider, config)) {
		return [config.ai.provider];
	}
	// 3. 自动：所有已配 key 的 provider，DeepSeek 优先
	const chain: Provider[] = [];
	if (hasApiKey("deepseek", config)) chain.push("deepseek");
	if (hasApiKey("glm", config)) chain.push("glm");
	if (chain.length === 0) return ["glm"]; // 触发缺 key 错误提示
	return chain;
}

function getAIConfig(provider: Provider, config: Config) {
	const spec = PROVIDERS[provider];
	const configured = config.ai?.model;
	// 配置里的 model 若是其他 provider 的默认值（常见：用户切了 provider 但没改 model），回落到当前 provider 默认
	const isOtherDefault = configured
		? Object.values(PROVIDERS).some(
				(s) => s !== spec && s.defaultModel === configured,
			)
		: false;
	const model = configured && !isOtherDefault ? configured : spec.defaultModel;
	const count = Math.max(5, Math.min(20, config.ai?.count || DEFAULT_COUNT));
	return { model, count };
}

export interface GenerateOptions {
	onName?: (name: string) => void;
	onProvider?: (info: {
		provider: Provider;
		fellBackFrom: Provider | null;
		error?: string;
	}) => void;
	exclude?: string[];
	debug?: boolean;
}

async function callProvider(
	provider: Provider,
	description: string,
	options: GenerateOptions,
	config: Config,
	markStreamStarted: () => void,
): Promise<string[]> {
	const spec = PROVIDERS[provider];
	const apiKey = getApiKey(provider, config);
	if (!apiKey) {
		throw new Error(`${spec.name} 未配置 API Key`);
	}

	const { model, count } = getAIConfig(provider, config);

	let systemPrompt = `你是一个项目命名助手。用户会描述一个项目，你需要生成 ${count} 个合适的项目名称。

${NAME_RULES}

每行一个名称，不要编号，不要其他内容。`;

	if (options.exclude && options.exclude.length > 0) {
		systemPrompt += `\n\n不要使用以下已生成的名称：\n${options.exclude.join("\n")}`;
	}

	if (options.debug) {
		console.log(pc.cyan("\n[DEBUG MODE]\n"));
		console.log(pc.dim("Provider:"), spec.name);
		console.log(pc.dim("Model:"), model);
		console.log(pc.dim("Count:"), count);
		console.log(pc.dim("\nSystem Prompt:"));
		console.log(pc.dim("─".repeat(40)));
		console.log(systemPrompt);
		console.log(pc.dim("─".repeat(40)));
		console.log(pc.dim("\nUser Input:"));
		console.log(description);
		console.log(pc.dim("\nStreaming...\n"));
	}

	const startTime = Date.now();

	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: description },
		],
		temperature: 0.6,
		stream: true,
	};
	if (spec.extraBody) Object.assign(body, spec.extraBody);

	const response = await fetch(spec.apiUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`${spec.name} API 请求失败 (${response.status}): ${text || response.statusText}`,
		);
	}

	if (!response.body) {
		throw new Error(`${spec.name} API 响应无 body`);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const names: string[] = [];
	let partial = "";
	let buffer = "";
	let firstTokenTime: number | null = null;
	let totalTokens = 0;

	function processPartial(force: boolean = false) {
		const parts = partial.split("\n");
		const endIndex = force ? parts.length : parts.length - 1;
		for (let i = 0; i < endIndex; i++) {
			const name = parts[i].trim();
			if (name && /^[a-z][a-z0-9-]*$/.test(name)) {
				names.push(name);
				options.onName?.(name);
			}
		}
		partial = force ? "" : parts[parts.length - 1];
	}

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
			try {
				const data = JSON.parse(line.slice(6));
				const delta = data.choices?.[0]?.delta?.content;
				if (delta) {
					if (firstTokenTime === null) {
						firstTokenTime = Date.now();
						markStreamStarted();
						if (options.debug) {
							console.log(
								pc.dim("First token:"),
								`${firstTokenTime - startTime}ms`,
							);
							console.log(pc.dim("\nRaw Output:"));
							console.log(pc.dim("─".repeat(40)));
						}
					}

					if (options.debug) {
						process.stdout.write(pc.dim(delta));
					}

					totalTokens++;
					partial += delta;
					processPartial();
				}
			} catch {
				// skip malformed SSE chunk
			}
		}
	}

	if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
		try {
			const data = JSON.parse(buffer.slice(6));
			const delta = data.choices?.[0]?.delta?.content;
			if (delta) {
				if (options.debug) {
					process.stdout.write(pc.dim(delta));
				}
				partial += delta;
			}
		} catch {
			// skip
		}
	}

	processPartial(true);

	const totalTime = Date.now() - startTime;

	if (options.debug) {
		console.log(pc.dim("\n" + "─".repeat(40)));
		console.log(pc.dim("\nTotal time:"), `${totalTime}ms`);
		console.log(
			pc.dim("First token:"),
			firstTokenTime ? `${firstTokenTime - startTime}ms` : "N/A",
		);
		console.log(pc.dim("Tokens:"), totalTokens);
		console.log(pc.dim("\nParsed names:"), names);
	}

	if (names.length === 0) {
		throw new Error(`${spec.name} 未生成有效名称`);
	}

	return names;
}

/**
 * 生成项目名称：按 provider 链顺序尝试，HTTP/鉴权类错误自动 fallback。
 * 一旦流式输出开始（onName 触发过），不再 fallback。
 */
export async function generateProjectNames(
	description: string,
	options?: GenerateOptions,
): Promise<string[]> {
	const config = loadConfig();
	const chain = buildProviderChain(config);

	if (chain.length === 0) {
		throw new LLMError(
			`未配置任何 AI provider 的 API Key。请在配置文件中设置 apiKey 或 deepseekApiKey，或通过环境变量 ZHIPU_API_KEY / DEEPSEEK_API_KEY 设置。`,
		);
	}

	const errors: string[] = [];
	let streamStarted = false;

	for (let i = 0; i < chain.length; i++) {
		const provider = chain[i];
		const fellBackFrom = i > 0 ? chain[i - 1] : null;

		if (streamStarted) {
			// 理论上不会走到这里：流开始后 callProvider 直接抛出，外层不会进下一个
			throw new LLMError(errors[errors.length - 1] || "流式输出中断");
		}

		options?.onProvider?.({ provider, fellBackFrom });

		try {
			const names = await callProvider(
				provider,
				description,
				options ?? {},
				config,
				() => {
					streamStarted = true;
				},
			);
			return names;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${PROVIDERS[provider].name}: ${msg}`);
			// 流已开始则不 fallback，直接抛
			if (streamStarted) {
				throw new LLMError(msg);
			}
			// 否则继续下一个 provider
		}
	}

	throw new LLMError(
		`所有 provider 都失败：\n${errors.map((e) => `  - ${e}`).join("\n")}`,
	);
}
