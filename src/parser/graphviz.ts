import type { ArtifactBlock } from "../renderer/types.ts";
import { ARTIFACT_VERSION } from "../artifact.ts";
import { parseFencedCodeBlocks } from "./markdown.ts";

export interface GraphvizBlock extends ArtifactBlock {
	type: "diagram";
	format: "dot";
}

export function extractGraphvizBlocks(markdown: string): GraphvizBlock[] {
	return parseFencedCodeBlocks(markdown)
		.filter((block) => {
			const language = block.language.toLowerCase();
			return language === "dot" || language === "graphviz";
		})
		.map(({ content, startLine, endLine }) => ({
			version: ARTIFACT_VERSION,
			type: "diagram",
			format: "dot",
			content,
			startLine,
			endLine,
		}));
}
