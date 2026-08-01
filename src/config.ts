import { homedir } from "node:os";
import { join } from "node:path";

export function configuredValue(
	names: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	for (const name of names) {
		const value = environment[name];
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

export function defaultArtifactCacheDirectory(environment: NodeJS.ProcessEnv = process.env): string {
	return (
		configuredValue(
			[
				"PI_INLINE_VIZ_CACHE_DIR",
				"AGENT_ARTIFACT_CACHE_DIR",
				"PI_RICH_MEDIA_CACHE_DIR",
			],
			environment,
		) ?? join(homedir(), ".cache", "pi-inline-viz")
	);
}

export function legacyArtifactCacheDirectories(): readonly string[] {
	return [
		join(homedir(), ".cache", "agent-artifact-renderer"),
		join(homedir(), ".cache", "pi-rich-media"),
	];
}
