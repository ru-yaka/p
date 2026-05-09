import * as readline from "node:readline";
import { Writable } from "node:stream";
import pc from "picocolors";
// @ts-expect-error — sisteransi is a transitive dep of @clack/prompts
import { cursor as ansiCursor, erase } from "sisteransi";

import { brand } from "./ui";

export interface LiveSearchOption {
	value: string;
	label: string;
	hint?: string;
}

export interface LiveSearchOptions {
	message: string;
	placeholder?: string;
	options: LiveSearchOption[];
	filterFn: (query: string) => LiveSearchOption[];
	initialQuery?: string;
}

interface SearchState {
	query: string;
	cursor: number;
	selectedIndex: number;
	scrollOffset: number;
	filtered: LiveSearchOption[];
}

const MAX_VISIBLE = 8;

/**
 * 取消标识（独立于 clack 内部 symbol）
 */
export const CANCEL = Symbol("live-search:cancel");

/**
 * 计算字符串的可视宽度（CJK 字符算 2 宽）
 */
function visualWidth(str: string): number {
	let width = 0;
	for (const char of str) {
		const code = char.codePointAt(0) ?? 0;
		if (
			code >= 0x1100 &&
			(code <= 0x115f ||
				(code >= 0x2e80 && code <= 0xa4cf) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff01 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x1f300 && code <= 0x1f9ff))
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/**
 * 构建输入行，光标位置用反色方块表示
 */
function buildInputLine(
	query: string,
	cursorPos: number,
	placeholder: string,
): string {
	if (query.length === 0 && placeholder) {
		return pc.inverse(placeholder[0]) + pc.dim(placeholder.slice(1));
	}
	const before = query.slice(0, cursorPos);
	const at = query[cursorPos];
	const after = query.slice(cursorPos + 1);
	const cursorChar = at ? pc.inverse(at) : pc.inverse(" ");
	return before + cursorChar + after;
}

/**
 * 实时搜索组件
 *
 * 渲染策略：
 * - 每次按键只做一次 stdout.write（防闪烁）
 * - 光标隐藏，用反色字符做视觉光标
 * - render 后光标停在块底部下一行
 * - 下次 render：up(blockHeight) 到块顶 → 逐行覆写（\x1b[K 清行尾） → 多余旧行清空
 * - 标题行纳入块内，提交/取消时整块替换为单行结果
 */
export async function liveSearch(
	opts: LiveSearchOptions,
): Promise<string | typeof CANCEL> {
	const stdin = process.stdin as NodeJS.ReadStream;
	const stdout = process.stdout as NodeJS.WriteStream;

	const interceptStream = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});

	stdin.setRawMode(true);
	stdin.resume();
	stdout.write(ansiCursor.hide);

	const rl = readline.createInterface({
		input: stdin,
		output: interceptStream,
		terminal: true,
	});
	readline.emitKeypressEvents(stdin, rl);

	const initialQuery = opts.initialQuery || "";
	const initialFiltered = initialQuery
		? opts.filterFn(initialQuery)
		: opts.options;

	const state: SearchState = {
		query: initialQuery,
		cursor: initialQuery.length,
		selectedIndex: 0,
		scrollOffset: 0,
		filtered: initialFiltered,
	};

	let blockHeight = 0;
	let resolved = false;

	function render() {
		const parts: string[] = [];

		// 移到块顶
		if (blockHeight > 0) {
			parts.push(ansiCursor.up(blockHeight));
		}

		// 构建所有行
		const lines: string[] = [];

		// 标题
		lines.push(`  ${brand.secondary("◆")} ${opts.message}`);

		// 输入
		const placeholder = opts.placeholder || "";
		const inputLine = buildInputLine(state.query, state.cursor, placeholder);
		lines.push(`  ${brand.secondary("│")} ${inputLine}`);

		// 分隔
		lines.push(`  ${brand.secondary("│")}`);

		// 结果
		const visibleCount = Math.min(
			MAX_VISIBLE,
			state.filtered.length - state.scrollOffset,
		);
		const visible = state.filtered.slice(
			state.scrollOffset,
			state.scrollOffset + visibleCount,
		);

		if (visible.length === 0) {
			lines.push(
				`  ${brand.secondary("│")}   ${pc.dim("没有匹配的项目")}`,
			);
		} else {
			for (let i = 0; i < visible.length; i++) {
				const idx = state.scrollOffset + i;
				const isSelected = idx === state.selectedIndex;
				const item = visible[i];
				const marker = isSelected ? brand.primary("◉") : pc.dim("○");
				const label = isSelected ? brand.bold(item.label) : item.label;
				const hint = item.hint ? pc.dim("  ") + item.hint : "";
				lines.push(
					`  ${brand.secondary("│")} ${marker} ${label}${hint}`,
				);
			}
		}

		// 滚动指示
		const remaining =
			state.filtered.length - state.scrollOffset - MAX_VISIBLE;
		if (remaining > 0) {
			lines.push(
				`  ${brand.secondary("│")}   ${pc.dim(`... 还有 ${remaining} 个`)}`,
			);
		}

		// 底部
		lines.push(
			`  ${brand.secondary("└")} ${pc.dim("输入筛选 · ↑↓ 选择 · Enter 确认 · Ctrl+A 全部打开 · Esc 取消")}`,
		);

		// 逐行覆写（\x1b[K 清行尾残留字符）
		for (const line of lines) {
			parts.push(line + "\x1b[K\n");
		}

		// 如果旧块更高，清除多余旧行
		if (blockHeight > lines.length) {
			for (let i = lines.length; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			// 回到新块底部下一行
			parts.push(ansiCursor.up(blockHeight - lines.length));
		}

		// 一次性写入，防闪烁
		stdout.write(parts.join(""));
		blockHeight = lines.length;
	}

	// 首次渲染
	render();

	return new Promise<string[] | typeof CANCEL>((resolve) => {
		function cleanup() {
			if (resolved) return;
			resolved = true;
			stdin.removeListener("keypress", onKey);
			stdin.setRawMode(false);
			stdin.pause();
			rl.close();
			stdout.write(ansiCursor.show);
		}

		function submit(value: string, label: string) {
			const parts: string[] = [];
			parts.push(ansiCursor.up(blockHeight));
			// 清除所有旧行
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			// 回到块顶，写结果行
			parts.push(ansiCursor.up(blockHeight));
			parts.push(
				`  ${brand.success("◆")} ${opts.message} ${brand.primary(label)}\n`,
			);
			stdout.write(parts.join(""));
			cleanup();
			resolve([value]);
		}

		function doCancel() {
			const parts: string[] = [];
			parts.push(ansiCursor.up(blockHeight));
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			parts.push(ansiCursor.up(blockHeight));
			parts.push(
				`  ${brand.secondary("◆")} ${opts.message} ${pc.dim("已取消")}\n`,
			);
			stdout.write(parts.join(""));
			cleanup();
			resolve(CANCEL);
		}

		function onKey(_char: string, key: readline.Key) {
			if (resolved) return;

			// Ctrl+C
			if (key.sequence === "\x03") {
				doCancel();
				return;
			}

			switch (key.name) {
				case "return": {
					if (state.filtered.length === 0) return;
					const selected = state.filtered[state.selectedIndex];
					submit(selected.value, selected.label);
					return;
				}
				case "escape": {
					doCancel();
					return;
				}
				case "a": {
					if (!key.ctrl) break;
					if (state.filtered.length > 0) {
						const parts: string[] = [];
						parts.push(ansiCursor.up(blockHeight));
						for (let i = 0; i < blockHeight; i++) {
							parts.push("\x1b[K\n");
						}
						parts.push(ansiCursor.up(blockHeight));
						parts.push(
							`  ${brand.success("◆")} ${opts.message} ${pc.dim(`打开全部 ${state.filtered.length} 个`)}\n`,
						);
						stdout.write(parts.join(""));
						cleanup();
						resolve(state.filtered.map((f) => f.value));
					}
					return;
				}
				case "backspace": {
					if (state.cursor > 0) {
						state.query =
							state.query.slice(0, state.cursor - 1) +
							state.query.slice(state.cursor);
						state.cursor--;
						refilter();
					}
					break;
				}
				case "delete": {
					if (state.cursor < state.query.length) {
						state.query =
							state.query.slice(0, state.cursor) +
							state.query.slice(state.cursor + 1);
						refilter();
					}
					break;
				}
				case "left": {
					if (state.cursor > 0) state.cursor--;
					break;
				}
				case "right": {
					if (state.cursor < state.query.length) state.cursor++;
					break;
				}
				case "up": {
					if (state.selectedIndex > 0) {
						state.selectedIndex--;
						if (state.selectedIndex < state.scrollOffset) {
							state.scrollOffset = state.selectedIndex;
						}
					} else if (state.filtered.length > 0) {
						state.selectedIndex = state.filtered.length - 1;
						state.scrollOffset = Math.max(
							0,
							state.filtered.length - MAX_VISIBLE,
						);
					}
					break;
				}
				case "down": {
					if (state.selectedIndex < state.filtered.length - 1) {
						state.selectedIndex++;
						if (
							state.selectedIndex >=
							state.scrollOffset + MAX_VISIBLE
						) {
							state.scrollOffset =
								state.selectedIndex - MAX_VISIBLE + 1;
						}
					} else if (state.filtered.length > 0) {
						state.selectedIndex = 0;
						state.scrollOffset = 0;
					}
					break;
				}
				default: {
					if (
						key.sequence &&
						key.sequence.length === 1 &&
						!key.ctrl &&
						!key.meta
					) {
						state.query =
							state.query.slice(0, state.cursor) +
							key.sequence +
							state.query.slice(state.cursor);
						state.cursor++;
						refilter();
					}
					break;
				}
			}

			render();
		}

		function refilter() {
			state.filtered = state.query
				? opts.filterFn(state.query)
				: opts.options;
			state.selectedIndex = 0;
			state.scrollOffset = 0;
		}

		stdin.on("keypress", onKey);
	});
}
