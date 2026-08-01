import { formatArtifactDoctorReport, inspectArtifactRuntime } from "../src/doctor.ts";

const report = await inspectArtifactRuntime();
process.stdout.write(`${formatArtifactDoctorReport(report)}\n`);
if (!report.ready) process.exitCode = 1;
