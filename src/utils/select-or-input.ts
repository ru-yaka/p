import * as readline from "node:readline";
import { Writable } from "node:stream";
import pc from "picocolors";
// @ts-expect-error — sisteransi is a transitive dep of @clack/prompts
import { cursor as ansiCursor, erase } from "sisteransi";

import { brand } from "./ui";

export interface SelectOrInputOption {
	value: string;
	label: string;
	hint?: string;
}

export interface SelectOrInputOptions {
	message: string;
	options: SelectOrInputOption[];
	placeholder?: string;
	validate?: (value: string) => string | undefined;
}

interface State {
	query: string;
	cursor: number;
	selectedIndex: number;
	scrollOffset: number;
	mode: "select" | "input";
}

const MAX_VISIBLE = 8;

export const CANCEL = Symbol("select-or-input:cancel");
export const CUSTOM_INPUT = Symbol("select-or-input:custom");

export async function selectOrInput(
	opts: SelectOrInputOptions,
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

	const state: State = {
		query: "",
		cursor: 0,
		selectedIndex: 0,
		scrollOffset: 0,
		mode: "select",
	};

	let blockHeight = 0;
	let resolved = false;

	function render() {
		const parts: string[] = [];

		if (blockHeight > 0) {
			parts.push(ansiCursor.up(blockHeight));
		}

		const lines: string[] = [];

		// 标题
		lines.push(`  ${brand.secondary("●")} ${opts.message}`);

		// 输入框
		const placeholder = opts.placeholder || "直接输入自定义名称...";
		let inputLine: string;
		if (state.query.length === 0) {
			inputLine = pc.inverse(placeholder[0]) + pc.dim(placeholder.slice(1));
		} else {
			const before = state.query.slice(0, state.cursor);
			const at = state.query[state.cursor];
			const after = state.query.slice(state.cursor + 1);
			const cursorChar = at ? pc.inverse(at) : pc.inverse(" ");
			inputLine = before + cursorChar + after;
		}
		lines.push(`  ${brand.secondary("│")} ${inputLine}`);

		// 分隔
		lines.push(`  ${brand.secondary("│")}`);

		// 选项
		const visibleCount = Math.min(
			MAX_VISIBLE,
			opts.options.length - state.scrollOffset,
		);
		const visible = opts.options.slice(
			state.scrollOffset,
			state.scrollOffset + visibleCount,
		);

		if (visible.length === 0) {
			lines.push(`  ${brand.secondary("│")}   ${pc.dim("没有选项")}`);
		} else {
			for (let i = 0; i < visible.length; i++) {
				const idx = state.scrollOffset + i;
				const isSelected = idx === state.selectedIndex && state.mode === "select";
				const item = visible[i];
				const marker = isSelected ? brand.primary("◉") : pc.dim("○");
				const label = isSelected ? brand.bold(item.label) : item.label;
				const hint = item.hint ? pc.dim("  ") + item.hint : "";
				lines.push(`  ${brand.secondary("│")} ${marker} ${label}${hint}`);
			}
		}

		// 滚动指示
		const remaining = opts.options.length - state.scrollOffset - MAX_VISIBLE;
		if (remaining > 0) {
			lines.push(`  ${brand.secondary("│")}   ${pc.dim(`... 还有 ${remaining} 个`)}`);
		}

		// 底部提示
		lines.push(
			`  ${brand.secondary("└")} ${pc.dim("直接输入 · ↑↓ 选择 · Enter 确认 · Esc 取消")}`,
		);

		for (const line of lines) {
			parts.push(line + "\x1b[K\n");
		}

		if (blockHeight > lines.length) {
			for (let i = lines.length; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			parts.push(ansiCursor.up(blockHeight - lines.length));
		}

		stdout.write(parts.join(""));
		blockHeight = lines.length;
	}

	render();

	return new Promise<string | typeof CANCEL>((resolve) => {
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
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			parts.push(ansiCursor.up(blockHeight));
			parts.push(
				`  ${brand.success("●")} ${opts.message} ${brand.primary(label)}\n`,
			);
			stdout.write(parts.join(""));
			cleanup();
			resolve(value);
		}

		function doCancel() {
			const parts: string[] = [];
			parts.push(ansiCursor.up(blockHeight));
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			parts.push(ansiCursor.up(blockHeight));
			parts.push(`  ${brand.secondary("●")} ${opts.message} ${pc.dim("已取消")}\n`);
			stdout.write(parts.join(""));
			cleanup();
			resolve(CANCEL);
		}

		function onKey(_char: string, key: readline.Key) {
			if (resolved) return;

			if (key.sequence === "\x03") {
				doCancel();
				return;
			}

			switch (key.name) {
				case "return": {
					// 如果有输入内容，使用输入内容
					if (state.query.trim()) {
						const trimmed = state.query.trim();
						const validation = opts.validate?.(trimmed);
						if (validation) {
							// 显示错误，不提交
							return;
						}
						submit(trimmed, trimmed);
						return;
					}
					// 否则使用选中的选项
					if (opts.options.length === 0) return;
					const selected = opts.options[state.selectedIndex];
					submit(selected.value, selected.label);
					return;
				}
				case "escape": {
					doCancel();
					return;
				}
				case "backspace": {
					if (state.cursor > 0) {
						state.query =
							state.query.slice(0, state.cursor - 1) +
							state.query.slice(state.cursor);
						state.cursor--;
					}
					break;
				}
				case "delete": {
					if (state.cursor < state.query.length) {
						state.query =
							state.query.slice(0, state.cursor) +
							state.query.slice(state.cursor + 1);
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
					state.mode = "select";
					if (state.selectedIndex > 0) {
						state.selectedIndex--;
						if (state.selectedIndex < state.scrollOffset) {
							state.scrollOffset = state.selectedIndex;
						}
					} else if (opts.options.length > 0) {
						state.selectedIndex = opts.options.length - 1;
						state.scrollOffset = Math.max(0, opts.options.length - MAX_VISIBLE);
					}
					break;
				}
				case "down": {
					state.mode = "select";
					if (state.selectedIndex < opts.options.length - 1) {
						state.selectedIndex++;
						if (state.selectedIndex >= state.scrollOffset + MAX_VISIBLE) {
							state.scrollOffset = state.selectedIndex - MAX_VISIBLE + 1;
						}
					} else if (opts.options.length > 0) {
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
						state.mode = "input";
					}
					break;
				}
			}

			render();
		}

		stdin.on("keypress", onKey);
	});
}
