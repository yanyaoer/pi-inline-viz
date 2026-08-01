import type { RichBlock } from "../renderer/types.ts";
import { ARTIFACT_VERSION } from "../artifact.ts";
import { parseFencedCodeBlocks } from "./markdown.ts";

export interface MermaidBlock extends RichBlock {
	type: "diagram";
	format: "mermaid";
}

export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
	return parseFencedCodeBlocks(markdown)
		.filter((block) => block.language.toLowerCase() === "mermaid")
		.map(({ content, startLine, endLine }) => ({
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "mermaid",
			content,
			startLine,
			endLine,
		}));
}
