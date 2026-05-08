import pc from "picocolors";

/**
 * 子序列匹配：query 的每个字符按顺序出现在 target 中
 */
function isSubsequence(query: string, target: string): boolean {
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

/**
 * 模糊匹配项目（子串 + 子序列匹配项目名、模板名或标签）
 */
export function filterProjects<
	T extends { name: string; template?: string; tags?: string[] },
>(projects: T[], query: string): T[] {
	const q = query.toLowerCase();
	return projects.filter(
		(p) =>
			p.name.toLowerCase().includes(q) ||
			(p.template && p.template.toLowerCase().includes(q)) ||
			(p.tags && p.tags.some((tag) => tag.toLowerCase().includes(q))) ||
			isSubsequence(q, p.name.toLowerCase()),
	);
}

/**
 * 构建项目选项的 hint 文本
 */
export function projectHint(p: {
	template?: string;
	tags?: string[];
	path: string;
	note?: string;
}): string {
	if (p.note) {
		const note = p.note.length > 30 ? `${p.note.slice(0, 30)}...` : p.note;
		return pc.dim(note);
	}
	const hints: string[] = [];
	if (p.template) hints.push(pc.cyan(p.template));
	if (p.tags && p.tags.length > 0) {
		hints.push(p.tags.map((t) => pc.magenta(`#${t}`)).join(" "));
	}
	return hints.length > 0 ? hints.join(" ") : pc.dim(p.path);
}
