import type { RichBlock } from "../renderer/types.ts";

export type LatexDisplayMode = "inline" | "block";

export interface LatexBlock extends RichBlock {
	type: "formula";
	language: "latex-inline" | "latex-display";
	displayMode: LatexDisplayMode;
}

interface OpenFence {
	character: "`" | "~";
	length: number;
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/;

export function extractLatexBlocks(markdown: string): LatexBlock[] {
	const searchable = maskMarkdownCode(markdown);
	const blocks: LatexBlock[] = [];
	let index = 0;
	let line = 1;

	while (index < searchable.length) {
		if (searchable[index] === "\n") {
			line += 1;
			index += 1;
			continue;
		}
		if (searchable[index] !== "$" || isEscaped(searchable, index)) {
			index += 1;
			continue;
		}

		const startLine = line;
		if (searchable[index + 1] === "$") {
			const close = findDisplayClose(searchable, index + 2);
			if (close === -1) {
				index += 2;
				continue;
			}
			const end = close + 2;
			blocks.push({
				type: "formula",
				language: "latex-display",
				displayMode: "block",
				content: markdown.slice(index + 2, close).trim(),
				startLine,
				endLine: startLine + countNewlines(searchable, index, end),
			});
			line += countNewlines(searchable, index, end);
			index = end;
			continue;
		}

		const next = searchable[index + 1];
		if (next === undefined || /\s/.test(next)) {
			index += 1;
			continue;
		}
		const close = findInlineClose(searchable, index + 1);
		if (close === -1) {
			index += 1;
			continue;
		}
		blocks.push({
			type: "formula",
			language: "latex-inline",
			displayMode: "inline",
			content: markdown.slice(index + 1, close).trim(),
			startLine,
			endLine: startLine,
		});
		index = close + 1;
	}

	return blocks;
}

function findDisplayClose(markdown: string, start: number): number {
	for (let index = start; index < markdown.length - 1; index += 1) {
		if (markdown[index] === "$" && markdown[index + 1] === "$" && !isEscaped(markdown, index)) {
			return index;
		}
	}
	return -1;
}

function findInlineClose(markdown: string, start: number): number {
	for (let index = start; index < markdown.length; index += 1) {
		const character = markdown[index];
		if (character === "\n") return -1;
		if (character !== "$" || isEscaped(markdown, index)) continue;
		if (markdown[index + 1] === "$") return -1;
		if (/\s/.test(markdown[index - 1] ?? "")) continue;
		if (/\d/.test(markdown[index + 1] ?? "")) continue;
		return index;
	}
	return -1;
}

function maskMarkdownCode(markdown: string): string {
	const masked = markdown.split("");
	let offset = 0;
	let openFence: OpenFence | undefined;

	while (offset < markdown.length) {
		const newline = markdown.indexOf("\n", offset);
		const end = newline === -1 ? markdown.length : newline;
		const next = newline === -1 ? markdown.length : newline + 1;
		const line = markdown.slice(offset, end).replace(/\r$/, "");

		if (openFence) {
			maskRange(masked, markdown, offset, next);
			if (isClosingFence(line, openFence)) openFence = undefined;
		} else {
			const match = OPENING_FENCE.exec(line);
			const fence = match?.[1];
			if (fence) {
				openFence = { character: fence[0] as "`" | "~", length: fence.length };
				maskRange(masked, markdown, offset, next);
			} else {
				maskInlineCode(masked, markdown, offset, end);
			}
		}
		offset = next;
	}

	return masked.join("");
}

function maskInlineCode(masked: string[], markdown: string, start: number, end: number): void {
	let index = start;
	while (index < end) {
		if (markdown[index] !== "`" || isEscaped(markdown, index)) {
			index += 1;
			continue;
		}
		const length = countRun(markdown, index, "`");
		const close = findRun(markdown, index + length, end, "`", length);
		if (close === -1) {
			index += length;
			continue;
		}
		maskRange(masked, markdown, index, close + length);
		index = close + length;
	}
}

function findRun(markdown: string, start: number, end: number, character: string, length: number): number {
	for (let index = start; index < end; index += 1) {
		if (markdown[index] === character && countRun(markdown, index, character) === length) return index;
	}
	return -1;
}

function countRun(markdown: string, start: number, character: string): number {
	let end = start;
	while (markdown[end] === character) end += 1;
	return end - start;
}

function isClosingFence(line: string, fence: OpenFence): boolean {
	const trimmed = line.replace(/^ {0,3}/, "").trimEnd();
	return trimmed.length >= fence.length && [...trimmed].every((character) => character === fence.character);
}

function maskRange(masked: string[], markdown: string, start: number, end: number): void {
	for (let index = start; index < end; index += 1) {
		if (markdown[index] !== "\n") masked[index] = " ";
	}
}

function isEscaped(markdown: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function countNewlines(markdown: string, start: number, end: number): number {
	let count = 0;
	for (let index = start; index < end; index += 1) {
		if (markdown[index] === "\n") count += 1;
	}
	return count;
}
