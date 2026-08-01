import { D2ArtifactAdapter } from "./adapters/d2.ts";
import { LatexArtifactAdapter } from "./adapters/latex.ts";
import { MermaidArtifactAdapter } from "./adapters/mermaid.ts";
import { SvgAssetRenderer } from "./renderer/svg.ts";
import type { RendererIdentity } from "./renderer/types.ts";

export type ArtifactDoctorCheckId = "d2" | "formula" | "mermaid" | "rasterizer";

export interface ArtifactDoctorCheck {
	id: ArtifactDoctorCheckId;
	label: string;
	status: "ready" | "missing";
	detail: string;
	fix?: string;
}

export interface ArtifactDoctorReport {
	ready: boolean;
	checks: readonly ArtifactDoctorCheck[];
}

export async function inspectArtifactRuntime(): Promise<ArtifactDoctorReport> {
	const checks = await Promise.all([
		inspectRenderer(
			"d2",
			"D2 diagrams",
			() => new D2ArtifactAdapter().getIdentity(),
			"Install D2 and ensure d2 is on PATH (macOS: brew install d2).",
		),
		inspectRenderer(
			"formula",
			"LaTeX formulas",
			() => new LatexArtifactAdapter().getIdentity(),
			"Run /inline-viz-install-ratex inside Pi.",
		),
		inspectRenderer(
			"mermaid",
			"Mermaid diagrams",
			() => new MermaidArtifactAdapter().getIdentity(),
			"Install mmdc (npm install -g @mermaid-js/mermaid-cli@11.16.0) and Chrome or Chromium.",
		),
		inspectRenderer(
			"rasterizer",
			"SVG rasterizer",
			() => new SvgAssetRenderer().getIdentity(),
			"Install librsvg or ImageMagick (macOS: brew install librsvg).",
		),
	]);
	return { ready: checks.every((check) => check.status === "ready"), checks };
}

export function formatArtifactDoctorReport(
	report: Readonly<ArtifactDoctorReport>,
	terminal?: string,
): string {
	const lines = ["Pi Inline Viz doctor"];
	for (const check of report.checks) {
		lines.push(`${check.status === "ready" ? "READY" : "MISSING"}  ${check.label}: ${check.detail}`);
		if (check.status === "missing" && check.fix) lines.push(`         Fix: ${check.fix}`);
	}
	if (terminal) lines.push(`TERMINAL ${terminal}`);
	lines.push(
		report.ready
			? "All artifact renderers are ready."
			: "Install the missing dependencies, then rerun /inline-viz-doctor.",
	);
	return lines.join("\n");
}

async function inspectRenderer(
	id: ArtifactDoctorCheckId,
	label: string,
	readIdentity: () => Promise<RendererIdentity>,
	fix: string,
): Promise<ArtifactDoctorCheck> {
	try {
		const identity = await readIdentity();
		return { id, label, status: "ready", detail: formatIdentity(identity) };
	} catch (error) {
		return {
			id,
			label,
			status: "missing",
			detail: compactError(error),
			fix,
		};
	}
}

function formatIdentity(identity: Readonly<RendererIdentity>): string {
	if (identity.id === "ratex-svg") return "render-svg with embedded fonts";
	return `${identity.id} (${identity.version.replace(/\s+/gu, " ").trim()})`;
}

function compactError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= 180 ? message : `${message.slice(0, 177)}...`;
}
