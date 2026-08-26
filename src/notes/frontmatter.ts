export interface EnsuredFrontmatter {
	content: string;
	added: boolean;
}

export function ensureFrontmatter(content: string, notePath: string, now = new Date()): EnsuredFrontmatter {
	const today = localDate(now);
	const defaults = new Map<string, string>([
		["title", JSON.stringify(titleFromPath(notePath))],
		["type", "note"],
		["status", "active"],
		["created", today],
		["updated", today],
		["tags", "[]"],
	]);

	const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0] !== "---") {
		return { content: `${formatHeader(defaults)}\n${content}`, added: true };
	}

	const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
	if (closingIndex < 0) {
		return { content: `${formatHeader(defaults)}\n${content}`, added: true };
	}

	const endIndex = closingIndex + 1;
	const headerLines = lines.slice(1, endIndex);
	const seen = new Set<string>();
	let updated = false;
	for (let index = 0; index < headerLines.length; index++) {
		const match = /^(title|type|status|created|updated|tags):(?:\s|$)/.exec(headerLines[index] ?? "");
		if (!match) continue;
		const key = match[1];
		seen.add(key);
		if (key === "updated") {
			headerLines[index] = `updated: ${today}`;
			updated = true;
		}
	}
	if (!updated) headerLines.push(`updated: ${today}`);
	for (const [key, value] of defaults) {
		if (!seen.has(key)) headerLines.push(`${key}: ${value}`);
	}

	const body = lines.slice(endIndex + 1).join("\n");
	return { content: `---\n${headerLines.join("\n")}\n---\n${body}`, added: false };
}

export function titleFromPath(notePath: string): string {
	const filename = notePath.replaceAll("\\", "/").split("/").at(-1) ?? notePath;
	return filename.replace(/\.md$/i, "") || "Untitled note";
}

function formatHeader(fields: Map<string, string>): string {
	return ["---", ...[...fields].map(([key, value]) => `${key}: ${value}`), "---"].join("\n");
}

function localDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
