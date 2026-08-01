import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	ansi256ArtifactColor,
	artifactColorLuminance,
	DEFAULT_ARTIFACT_PALETTE,
	resolveArtifactPalette,
	type ArtifactColor,
	type ArtifactColorScheme,
	type ArtifactPalette,
} from "./palette.ts";

const DARK_FALLBACK: Readonly<ArtifactPalette> = Object.freeze({
	mode: "dark",
	background: "#18181e",
	foreground: "#d4d4d4",
	accent: "#8abeb7",
	muted: "#808080",
	border: "#5f87ff",
});

export function artifactPaletteFromPiTheme(theme: Theme | undefined): Readonly<ArtifactPalette> {
	if (!theme) return DEFAULT_ARTIFACT_PALETTE;

	const background = readThemeColor(() => theme.getBgAnsi("customMessageBg"));
	const foreground =
		readThemeColor(() => theme.getFgAnsi("customMessageText")) ??
		readThemeColor(() => theme.getFgAnsi("text"));
	const mode = detectColorScheme(theme.name, background, foreground);
	const fallback = mode === "dark" ? DARK_FALLBACK : DEFAULT_ARTIFACT_PALETTE;

	return resolveArtifactPalette({
		mode,
		background: background ?? fallback.background,
		foreground: foreground ?? fallback.foreground,
		accent: readThemeColor(() => theme.getFgAnsi("accent")) ?? fallback.accent,
		muted: readThemeColor(() => theme.getFgAnsi("muted")) ?? fallback.muted,
		border: readThemeColor(() => theme.getFgAnsi("border")) ?? fallback.border,
	});
}

export function artifactColorFromAnsi(ansi: string): ArtifactColor | undefined {
	const trueColor = /\u001b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/u.exec(ansi);
	if (trueColor) {
		const channels = trueColor.slice(1, 4).map(Number);
		if (channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
			return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
		}
	}
	const indexed = /\u001b\[(?:38|48);5;(\d{1,3})m/u.exec(ansi);
	if (indexed) return ansi256ArtifactColor(Number(indexed[1]));

	const basic = /\u001b\[(3[0-7]|9[0-7]|4[0-7]|10[0-7])m/u.exec(ansi);
	if (!basic) return undefined;
	const code = Number(basic[1]);
	const index = code >= 100 ? code - 92 : code >= 90 ? code - 82 : code >= 40 ? code - 40 : code - 30;
	return ansi256ArtifactColor(index);
}

function readThemeColor(read: () => string): ArtifactColor | undefined {
	try {
		return artifactColorFromAnsi(read());
	} catch {
		return undefined;
	}
}

function detectColorScheme(
	name: string | undefined,
	background: ArtifactColor | undefined,
	foreground: ArtifactColor | undefined,
): ArtifactColorScheme {
	if (background) return artifactColorLuminance(background) >= 0.5 ? "light" : "dark";
	if (name === "light") return "light";
	if (name === "dark") return "dark";
	if (foreground) return artifactColorLuminance(foreground) >= 0.5 ? "dark" : "light";
	return "dark";
}
