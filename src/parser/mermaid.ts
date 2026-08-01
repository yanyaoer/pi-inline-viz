import type { RichBlock } from "../renderer/types.ts";
import { parseFencedCodeBlocks } from "./markdown.ts";

export interface MermaidBlock extends RichBlock {
	type: "diagram";
	language: "mermaid";
}

export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
	return parseFencedCodeBlocks(markdown)
		.filter((block) => block.language.toLowerCase() === "mermaid")
		.map(({ content, startLine, endLine }) => ({
			type: "diagram",
			language: "mermaid",
			content,
			startLine,
			endLine,
		}));
}
