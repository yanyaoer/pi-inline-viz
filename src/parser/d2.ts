import { parseFencedCodeBlocks } from "./markdown.ts";
import type { RichBlock } from "../renderer/types.ts";

export interface D2Block extends RichBlock {
	type: "diagram";
	language: "d2";
}

export function extractD2Blocks(markdown: string): D2Block[] {
	return parseFencedCodeBlocks(markdown)
		.filter((block) => block.language.toLowerCase() === "d2")
		.map(({ content, startLine, endLine }) => ({
			type: "diagram",
			language: "d2",
			content,
			startLine,
			endLine,
		}));
}
