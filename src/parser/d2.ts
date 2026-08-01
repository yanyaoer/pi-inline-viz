import { parseFencedCodeBlocks } from "./markdown.ts";
import { ARTIFACT_VERSION } from "../artifact.ts";
import type { RichBlock } from "../renderer/types.ts";

export interface D2Block extends RichBlock {
	type: "diagram";
	format: "d2";
}

export function extractD2Blocks(markdown: string): D2Block[] {
	return parseFencedCodeBlocks(markdown)
		.filter((block) => block.language.toLowerCase() === "d2")
		.map(({ content, startLine, endLine }) => ({
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "d2",
			content,
			startLine,
			endLine,
		}));
}
