import { readFile, stat, writeFile } from "node:fs/promises";

export interface GeneratedSvgValidationOptions {
	producer: string;
	stripLeadingMarkup?: boolean;
}

export async function validateGeneratedSvg(
	path: string,
	maximumBytes: number,
	options: Readonly<GeneratedSvgValidationOptions>,
): Promise<void> {
	const file = await stat(path);
	if (!file.isFile() || file.size === 0) {
		throw new Error(`${options.producer} produced no SVG output`);
	}
	if (file.size > maximumBytes) {
		throw new Error(`${options.producer} SVG exceeds the ${maximumBytes}-byte limit`);
	}

	let svg = (await readFile(path, "utf8")).trim();
	if (options.stripLeadingMarkup) {
		const root = svg.search(/<svg(?:\s|>)/u);
		if (root < 0) throw new Error(`${options.producer} produced invalid SVG output`);
		svg = svg.slice(root).trim();
		await writeFile(path, `${svg}\n`, { mode: 0o600 });
	}

	if (!svg.startsWith("<svg") || !svg.endsWith("</svg>") || svg.indexOf("<svg", 1) !== -1) {
		throw new Error(`${options.producer} produced invalid SVG output`);
	}
	if (/<!DOCTYPE|<!ENTITY|<\?/iu.test(svg)) {
		throw new Error(`${options.producer} SVG contains an external document declaration`);
	}
	if (/<\s*(?:embed|foreignObject|iframe|image|object|script)\b/iu.test(svg)) {
		throw new Error(`${options.producer} SVG contains an unsafe element`);
	}
	if (/\son[a-z][\w:.-]*\s*=/iu.test(svg)) {
		throw new Error(`${options.producer} SVG contains an event handler`);
	}
	if (/\b(?:href|xlink:href|src)\s*=\s*(["'])(?!#)[\s\S]*?\1/iu.test(svg)) {
		throw new Error(`${options.producer} SVG contains an external reference`);
	}
	if (/@import\b|url\(\s*(?!#|["']#)/iu.test(svg)) {
		throw new Error(`${options.producer} SVG contains an external stylesheet reference`);
	}
}
