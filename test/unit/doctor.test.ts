import assert from "node:assert/strict";
import test from "node:test";

import { formatArtifactDoctorReport, type ArtifactDoctorReport } from "../../src/doctor.ts";

test("formats actionable runtime diagnostics", () => {
	const report: ArtifactDoctorReport = {
		ready: false,
		checks: [
			{ id: "d2", label: "D2 diagrams", status: "ready", detail: "d2 (0.7.1)" },
			{
				id: "mermaid",
				label: "Mermaid diagrams",
				status: "missing",
				detail: "mmdc is not executable or is not on PATH",
				fix: "Install mmdc.",
			},
		],
	};
	const output = formatArtifactDoctorReport(report, "kitty/direct; Unicode placeholders=yes");
	assert.match(output, /^Pi Inline Viz doctor/m);
	assert.match(output, /READY\s+D2 diagrams/);
	assert.match(output, /MISSING\s+Mermaid diagrams/);
	assert.match(output, /Fix: Install mmdc\./);
	assert.match(output, /TERMINAL kitty\/direct/);
	assert.match(output, /rerun \/inline-viz-doctor/);
});
