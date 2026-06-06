import pc from "picocolors";

/**
 * 模糊匹配项目（子串匹配项目名、模板名或标签）
 */
export function filterProjects<
	T extends { name: string; template?: string; tags?: string[] },
>(projects: T[], query: string): T[] {
	const q = query.toLowerCase();
	return projects.filter(
		(p) =>
			p.name.toLowerCase().includes(q) ||
			(p.template && p.template.toLowerCase().includes(q)) ||
			(p.tags && p.tags.some((tag) => tag.toLowerCase().includes(q))),
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
