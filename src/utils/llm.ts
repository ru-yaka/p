import pc from "picocolors";

import { loadConfig } from "../core/config";

const GLM_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_MODEL = "glm-4.7-flash";
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

export function getApiKey(): string | null {
	const envKey = process.env.ZHIPU_API_KEY;
	if (envKey) return envKey;

	const config = loadConfig();
	return config.apiKey || null;
}

function getAIConfig() {
	const config = loadConfig();
	const model = config.ai?.model || DEFAULT_MODEL;
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
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new LLMError(
			`未配置 API Key。请设置环境变量：\n  ${pc.cyan("export ZHIPU_API_KEY=your-key")}\n或在配置文件中设置 apiKey。\n\n免费获取：${pc.underline("https://open.bigmodel.cn/")}`,
		);
	}

	const { model, count } = getAIConfig();

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

	const response = await fetch(GLM_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: description },
			],
			temperature: 0.6,
			thinking: { type: "disabled" },
			stream: true,
		}),
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
		console.log(pc.dim("First token:"), firstTokenTime ? `${firstTokenTime - startTime}ms` : "N/A");
		console.log(pc.dim("Tokens:"), totalTokens);
		console.log(pc.dim("\nParsed names:"), names);
	}

	if (names.length === 0) {
		throw new LLMError("AI 未生成有效名称");
	}

	return names;
}
