export type ArtifactColor = `#${string}`;
export type ArtifactColorScheme = "dark" | "light";

export interface ArtifactPalette {
	mode: ArtifactColorScheme;
	background: ArtifactColor;
	foreground: ArtifactColor;
	accent: ArtifactColor;
	muted: ArtifactColor;
	border: ArtifactColor;
}

export const DEFAULT_ARTIFACT_PALETTE: Readonly<ArtifactPalette> = Object.freeze({
	mode: "light",
	background: "#f8f8f8",
	foreground: "#1f2328",
	accent: "#5a8080",
	muted: "#6c6c6c",
	border: "#547da7",
});

const PALETTE_KEYS = new Set(["mode", "background", "foreground", "accent", "muted", "border"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function resolveArtifactPalette(
	palette: Readonly<ArtifactPalette> = DEFAULT_ARTIFACT_PALETTE,
): Readonly<ArtifactPalette> {
	for (const key of Object.keys(palette)) {
		if (!PALETTE_KEYS.has(key)) throw new Error(`unsupported palette option: ${key}`);
	}
	if (palette.mode !== "dark" && palette.mode !== "light") {
		throw new Error(`unsupported palette mode: ${String(palette.mode)}`);
	}
	return Object.freeze({
		mode: palette.mode,
		background: normalizeArtifactColor(palette.background),
		foreground: normalizeArtifactColor(palette.foreground),
		accent: normalizeArtifactColor(palette.accent),
		muted: normalizeArtifactColor(palette.muted),
		border: normalizeArtifactColor(palette.border),
	});
}

export function normalizeArtifactColor(color: string): ArtifactColor {
	if (!HEX_COLOR.test(color)) throw new Error(`invalid artifact color: ${String(color)}`);
	return color.toLowerCase() as ArtifactColor;
}

export function mixArtifactColors(
	background: ArtifactColor,
	foreground: ArtifactColor,
	foregroundWeight: number,
): ArtifactColor {
	if (!Number.isFinite(foregroundWeight) || foregroundWeight < 0 || foregroundWeight > 1) {
		throw new Error("color mix weight must be between 0 and 1");
	}
	const left = parseArtifactColor(background);
	const right = parseArtifactColor(foreground);
	const channel = (name: keyof typeof left) =>
		Math.round(left[name] * (1 - foregroundWeight) + right[name] * foregroundWeight);
	return formatArtifactColor({ r: channel("r"), g: channel("g"), b: channel("b") });
}

export function artifactColorLuminance(color: ArtifactColor): number {
	const { r, g, b } = parseArtifactColor(color);
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function ansi256ArtifactColor(index: number): ArtifactColor | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	const basic = [
		"#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
		"#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
	] as const;
	if (index < 16) return basic[index];
	if (index < 232) {
		const cube = index - 16;
		const value = (component: number) => component === 0 ? 0 : 55 + component * 40;
		return formatArtifactColor({
			r: value(Math.floor(cube / 36)),
			g: value(Math.floor((cube % 36) / 6)),
			b: value(cube % 6),
		});
	}
	const gray = 8 + (index - 232) * 10;
	return formatArtifactColor({ r: gray, g: gray, b: gray });
}

function parseArtifactColor(color: ArtifactColor): { r: number; g: number; b: number } {
	const normalized = normalizeArtifactColor(color);
	return {
		r: Number.parseInt(normalized.slice(1, 3), 16),
		g: Number.parseInt(normalized.slice(3, 5), 16),
		b: Number.parseInt(normalized.slice(5, 7), 16),
	};
}

function formatArtifactColor(color: { r: number; g: number; b: number }): ArtifactColor {
	const channel = (value: number) => value.toString(16).padStart(2, "0");
	return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}
