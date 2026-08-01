import { homedir } from "node:os";
import { join } from "node:path";

export function artifactEnvironment(
	name: string,
	legacyName: string,
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return environment[name] ?? environment[legacyName];
}

export function defaultArtifactCacheDirectory(environment: NodeJS.ProcessEnv = process.env): string {
	return (
		artifactEnvironment("AGENT_ARTIFACT_CACHE_DIR", "PI_RICH_MEDIA_CACHE_DIR", environment) ??
		join(homedir(), ".cache", "agent-artifact-renderer")
	);
}

export function legacyArtifactCacheDirectory(): string {
	return join(homedir(), ".cache", "pi-rich-media");
}
