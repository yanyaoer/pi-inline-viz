export interface FencedCodeBlock {
	language: string;
	content: string;
	startLine: number;
	endLine: number;
}

interface OpenFence {
	character: "`" | "~";
	length: number;
	language: string;
	startLine: number;
	content: string[];
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})[^\S\r\n]*(\S*)[^\r\n]*$/;

export function parseFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
	const lines = markdown.split(/\r?\n/);
	const blocks: FencedCodeBlock[] = [];
	let open: OpenFence | undefined;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";

		if (open) {
			if (isClosingFence(line, open.character, open.length)) {
				blocks.push({
					language: open.language,
					content: open.content.join("\n"),
					startLine: open.startLine,
					endLine: index + 1,
				});
				open = undefined;
			} else {
				open.content.push(line);
			}
			continue;
		}

		const match = OPENING_FENCE.exec(line);
		if (!match?.[1]) continue;

		const fence = match[1];
		open = {
			character: fence[0] as "`" | "~",
			length: fence.length,
			language: match[2] ?? "",
			startLine: index + 1,
			content: [],
		};
	}

	return blocks;
}

function isClosingFence(line: string, character: "`" | "~", minimumLength: number): boolean {
	const trimmed = line.replace(/^ {0,3}/, "").trimEnd();
	if (trimmed.length < minimumLength) return false;
	for (const candidate of trimmed) {
		if (candidate !== character) return false;
	}
	return true;
}
