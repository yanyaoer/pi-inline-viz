import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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

export function defaultArtifactCacheDirectory(
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	const configured = configuredValue(
		[
			"PI_INLINE_VIZ_CACHE_DIR",
			"AGENT_ARTIFACT_CACHE_DIR",
			"PI_RICH_MEDIA_CACHE_DIR",
		],
		environment,
	);
	if (configured) return configured;
	const xdgCache = configuredValue(["XDG_CACHE_HOME"], environment);
	return join(xdgCache && isAbsolute(xdgCache) ? xdgCache : join(homeDirectory, ".cache"), "pi-inline-viz");
}

export function legacyArtifactCacheDirectories(): readonly string[] {
	return [
		join(homedir(), ".cache", "agent-artifact-renderer"),
		join(homedir(), ".cache", "pi-rich-media"),
	];
}
