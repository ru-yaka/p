import pc from "picocolors";

import { loadConfig } from "../core/config";
import type { Config } from "../types";

type Provider = "glm" | "deepseek";

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

function pickProvider(config: Config): Provider {
	const explicit = config.ai?.provider;
	if (explicit === "glm" || explicit === "deepseek") return explicit;

	// 自动推断：只有一边配了 key 时用那一边；两边都配或都没配默认 GLM
	const hasGlm = !!(process.env.ZHIPU_API_KEY || config.apiKey);
	const hasDs = !!(process.env.DEEPSEEK_API_KEY || config.deepseekApiKey);
	if (!hasGlm && hasDs) return "deepseek";
	return "glm";
}

function getApiKey(provider: Provider): string | null {
	const spec = PROVIDERS[provider];
	const config = loadConfig();
	const envKey = process.env[spec.envKey];
	if (envKey) return envKey;
	const configVal = config[spec.configKey] as string | undefined;
	return configVal || null;
}

function getAIConfig(provider: Provider) {
	const config = loadConfig();
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
	exclude?: string[];
	debug?: boolean;
}

export async function generateProjectNames(
	description: string,
	options?: GenerateOptions,
): Promise<string[]> {
	const config = loadConfig();
	const provider = pickProvider(config);
	const spec = PROVIDERS[provider];

	const apiKey = getApiKey(provider);
	if (!apiKey) {
		throw new LLMError(
			`未配置 ${spec.name} API Key。请设置环境变量：\n  ${pc.cyan(`export ${spec.envKey}=your-key`)}\n或在配置文件中设置 ${spec.configKey}。\n\n免费获取：${pc.underline(spec.docsUrl)}`,
		);
	}

	const { model, count } = getAIConfig(provider);

	// 构建系统提示词，排除已有名称
	let systemPrompt = `你是一个项目命名助手。用户会描述一个项目，你需要生成 ${count} 个合适的项目名称。

${NAME_RULES}

每行一个名称，不要编号，不要其他内容。`;

	if (options?.exclude && options.exclude.length > 0) {
		systemPrompt += `\n\n不要使用以下已生成的名称：\n${options.exclude.join("\n")}`;
	}

	// Debug 模式
	if (options?.debug) {
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
		throw new LLMError(
			`API 请求失败 (${response.status}): ${text || response.statusText}`,
		);
	}

	if (!response.body) {
		throw new LLMError("API 响应无 body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const names: string[] = [];
	let partial = "";
	let buffer = "";
	let firstTokenTime: number | null = null;
	let totalTokens = 0;

	// 解析并输出名称的辅助函数
	function processPartial(force: boolean = false) {
		const parts = partial.split("\n");
		const endIndex = force ? parts.length : parts.length - 1;
		for (let i = 0; i < endIndex; i++) {
			const name = parts[i].trim();
			if (name && /^[a-z][a-z0-9-]*$/.test(name)) {
				names.push(name);
				options?.onName?.(name);
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
					// 记录首字符响应时间
					if (firstTokenTime === null) {
						firstTokenTime = Date.now();
						if (options?.debug) {
							console.log(
								pc.dim("First token:"),
								`${firstTokenTime - startTime}ms`,
							);
							console.log(pc.dim("\nRaw Output:"));
							console.log(pc.dim("─".repeat(40)));
						}
					}

					if (options?.debug) {
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

	// 处理 buffer 中剩余的数据
	if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
		try {
			const data = JSON.parse(buffer.slice(6));
			const delta = data.choices?.[0]?.delta?.content;
			if (delta) {
				if (options?.debug) {
					process.stdout.write(pc.dim(delta));
				}
				partial += delta;
			}
		} catch {
			// skip
		}
	}

	// 强制处理剩余的 partial
	processPartial(true);

	const totalTime = Date.now() - startTime;

	if (options?.debug) {
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
		throw new LLMError("AI 未生成有效名称");
	}

	return names;
}
