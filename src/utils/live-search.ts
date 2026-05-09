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
	multiSelect?: boolean;
}

interface SearchState {
	query: string;
	cursor: number;
	selectedIndex: number;
	scrollOffset: number;
	filtered: LiveSearchOption[];
	checked: Set<string>;
}

const MAX_VISIBLE = 8;

export const CANCEL = Symbol("live-search:cancel");

function buildInputLine(query: string, cursorPos: number, placeholder: string): string {
	if (query.length === 0 && placeholder) {
		return pc.inverse(placeholder[0]) + pc.dim(placeholder.slice(1));
	}
	const before = query.slice(0, cursorPos);
	const at = query[cursorPos];
	const after = query.slice(cursorPos + 1);
	const cursorChar = at ? pc.inverse(at) : pc.inverse(" ");
	return before + cursorChar + after;
}

export async function liveSearch(
	opts: LiveSearchOptions,
): Promise<string[] | typeof CANCEL> {
	const stdin = process.stdin as NodeJS.ReadStream;
	const stdout = process.stdout as NodeJS.WriteStream;
	const multi = opts.multiSelect ?? false;

	const interceptStream = new Writable({
		write(_chunk, _encoding, callback) { callback(); },
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
		checked: new Set(),
	};

	let blockHeight = 0;
	let resolved = false;

	function render() {
		const parts: string[] = [];
		if (blockHeight > 0) parts.push(ansiCursor.up(blockHeight));

		const lines: string[] = [];

		// 标题（多选时显示已选数量）
		const countTag = multi && state.checked.size > 0
			? pc.dim(` (已选 ${state.checked.size})`)
			: "";
		lines.push(`  ${brand.secondary("◆")} ${opts.message}${countTag}`);

		// 输入
		const placeholder = opts.placeholder || "";
		const inputLine = buildInputLine(state.query, state.cursor, placeholder);
		lines.push(`  ${brand.secondary("│")} ${inputLine}`);

		// 分隔
		lines.push(`  ${brand.secondary("│")}`);

		// 结果列表
		const visibleCount = Math.min(MAX_VISIBLE, state.filtered.length - state.scrollOffset);
		const visible = state.filtered.slice(state.scrollOffset, state.scrollOffset + visibleCount);

		if (visible.length === 0) {
			lines.push(`  ${brand.secondary("│")}   ${pc.dim("没有匹配的项目")}`);
		} else {
			for (let i = 0; i < visible.length; i++) {
				const idx = state.scrollOffset + i;
				const isCursor = idx === state.selectedIndex;
				const item = visible[i];

				let marker: string;
				if (multi) {
					const checked = state.checked.has(item.value);
					const box = checked ? pc.green("■") : pc.dim("□");
					marker = isCursor ? brand.primary("▸") + box : pc.dim(" ") + box;
				} else {
					marker = isCursor ? brand.primary("◉") : pc.dim("○");
				}

				const label = isCursor ? brand.bold(item.label) : item.label;
				const hint = item.hint ? pc.dim("  ") + item.hint : "";
				lines.push(`  ${brand.secondary("│")} ${marker} ${label}${hint}`);
			}
		}

		// 滚动指示
		const remaining = state.filtered.length - state.scrollOffset - MAX_VISIBLE;
		if (remaining > 0) {
			lines.push(`  ${brand.secondary("│")}   ${pc.dim(`... 还有 ${remaining} 个`)}`);
		}

		// 底部提示
		let hint = "输入筛选 · ↑↓ 选择 · Enter 确认";
		if (multi) hint += " · Space 切换 · Ctrl+A 全选";
		hint += " · Esc 取消";
		lines.push(`  ${brand.secondary("└")} ${pc.dim(hint)}`);

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

		function submitResult(values: string[], label: string) {
			const parts: string[] = [];
			parts.push(ansiCursor.up(blockHeight));
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			parts.push(ansiCursor.up(blockHeight));
			parts.push(`  ${brand.success("◆")} ${opts.message} ${brand.primary(label)}\n`);
			stdout.write(parts.join(""));
			cleanup();
			resolve(values);
		}

		function doCancel() {
			const parts: string[] = [];
			parts.push(ansiCursor.up(blockHeight));
			for (let i = 0; i < blockHeight; i++) {
				parts.push("\x1b[K\n");
			}
			parts.push(ansiCursor.up(blockHeight));
			parts.push(`  ${brand.secondary("◆")} ${opts.message} ${pc.dim("已取消")}\n`);
			stdout.write(parts.join(""));
			cleanup();
			resolve(CANCEL);
		}

		function toggleCurrent() {
			const item = state.filtered[state.selectedIndex];
			if (!item) return;
			if (state.checked.has(item.value)) {
				state.checked.delete(item.value);
			} else {
				state.checked.add(item.value);
			}
		}

		function toggleAll() {
			if (state.filtered.every(f => state.checked.has(f.value))) {
				// 全部已选 → 取消全选
				for (const f of state.filtered) state.checked.delete(f.value);
			} else {
				// 全选
				for (const f of state.filtered) state.checked.add(f.value);
			}
		}

		function onKey(_char: string, key: readline.Key) {
			if (resolved) return;

			// Ctrl+C
			if (key.sequence === "\x03") {
				doCancel();
				return;
			}

			// Ctrl+A: 全选/取消全选
			if (multi && key.name === "a" && key.ctrl) {
				toggleAll();
				render();
				return;
			}

			// Space: 切换当前项
			if (multi && key.name === "space") {
				toggleCurrent();
				render();
				return;
			}

			switch (key.name) {
				case "return": {
					if (state.filtered.length === 0) return;

					if (multi) {
						// 多选：返回已勾选项，没有勾选则用当前项
						if (state.checked.size > 0) {
							const values = [...state.checked];
							submitResult(values, `${values.length} 个项目`);
						} else {
							const item = state.filtered[state.selectedIndex];
							submitResult([item.value], item.label);
						}
					} else {
						const selected = state.filtered[state.selectedIndex];
						submitResult([selected.value], selected.label);
					}
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
						state.scrollOffset = Math.max(0, state.filtered.length - MAX_VISIBLE);
					}
					break;
				}
				case "down": {
					if (state.selectedIndex < state.filtered.length - 1) {
						state.selectedIndex++;
						if (state.selectedIndex >= state.scrollOffset + MAX_VISIBLE) {
							state.scrollOffset = state.selectedIndex - MAX_VISIBLE + 1;
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
			// 移除不再可见的 checked 项
			if (multi) {
				const visible = new Set(state.filtered.map(f => f.value));
				for (const v of state.checked) {
					if (!visible.has(v)) state.checked.delete(v);
				}
			}
		}

		stdin.on("keypress", onKey);
	});
}
