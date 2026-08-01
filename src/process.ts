import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandOptions {
	cwd: string;
	home: string;
	timeoutMs?: number;
	maxBufferBytes?: number;
	environment?: NodeJS.ProcessEnv;
}

export interface ExecutableResolutionOptions {
	environment?: NodeJS.ProcessEnv;
	homeDirectory?: string;
	nodeExecutable?: string;
	platform?: NodeJS.Platform;
	cwd?: string;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface CommandFailure extends Error {
	code?: string | number;
}

export async function runCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions,
): Promise<CommandResult> {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			env: minimalEnvironment(options.home, options.environment),
			encoding: "utf8",
			timeout: options.timeoutMs ?? 15_000,
			maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
			windowsHide: true,
		});
		return {
			stdout: String(result.stdout),
			stderr: String(result.stderr),
		};
	} catch (error) {
		const original = error as CommandFailure & { stderr?: string };
		const detail = original.stderr?.trim();
		const failure = new Error(
			detail ? `${command} failed: ${detail}` : `${command} failed: ${original.message}`,
			{ cause: error },
		) as CommandFailure;
		if (original.code !== undefined) failure.code = original.code;
		throw failure;
	}
}

export function isCommandMissing(error: unknown): boolean {
	return (error as CommandFailure | undefined)?.code === "ENOENT";
}

export async function resolveExecutable(
	command: string,
	options: ExecutableResolutionOptions = {},
): Promise<string> {
	const environment = options.environment ?? process.env;
	const homeDirectory = options.homeDirectory ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const candidates = command.includes("/") || command.includes("\\")
		? [resolveCommandPath(command, homeDirectory, cwd)]
		: executableSearchDirectories({
				...options,
				environment,
				homeDirectory,
			})
				.map((directory) => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	const error = new Error(
		`${command} is not executable or was not found in ${candidates.length} searched locations`,
	) as CommandFailure;
	error.code = "ENOENT";
	throw error;
}

function executableSearchDirectories(
	options: Required<Pick<ExecutableResolutionOptions, "environment" | "homeDirectory">> &
		ExecutableResolutionOptions,
): readonly string[] {
	const { environment, homeDirectory } = options;
	const platform = options.platform ?? process.platform;
	const nodeExecutable = options.nodeExecutable ?? process.execPath;
	const directories = (environment.PATH ?? "").split(delimiter).filter(Boolean);
	if (platform !== "win32") {
		directories.push(
			dirname(nodeExecutable),
			...configuredBinDirectories(environment),
			join(homeDirectory, "bin"),
			join(homeDirectory, ".local", "bin"),
			join(homeDirectory, ".local", "share", "npm", "bin"),
			join(homeDirectory, ".npm-global", "bin"),
			join(homeDirectory, ".cargo", "bin"),
			join(homeDirectory, "go", "bin"),
			join(homeDirectory, ".linuxbrew", "bin"),
			"/home/linuxbrew/.linuxbrew/bin",
			"/opt/homebrew/bin",
			"/opt/local/bin",
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/snap/bin",
		);
	}
	return [...new Set(directories.filter(isAbsolute))];
}

function configuredBinDirectories(environment: NodeJS.ProcessEnv): string[] {
	const directories = [environment.PNPM_HOME, environment.XDG_BIN_HOME, environment.GOBIN];
	for (const root of (environment.GOPATH ?? "").split(delimiter).filter(Boolean)) {
		directories.push(join(root, "bin"));
	}
	for (const root of [
		environment.NPM_CONFIG_PREFIX,
		environment.npm_config_prefix,
		environment.VOLTA_HOME,
		environment.BUN_INSTALL,
	]) {
		if (root) directories.push(join(root, "bin"));
	}
	return directories.filter((directory): directory is string => Boolean(directory));
}

function resolveCommandPath(command: string, homeDirectory: string, cwd: string): string {
	if (command === "~") return homeDirectory;
	if (command.startsWith("~/") || command.startsWith("~\\")) {
		return resolve(homeDirectory, command.slice(2));
	}
	return resolve(cwd, command);
}

function minimalEnvironment(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HOME: home,
		XDG_CACHE_HOME: home,
		NO_COLOR: "1",
		PATH: executableSearchDirectories({
			environment: process.env,
			homeDirectory: homedir(),
		}).join(delimiter),
	};
	for (const name of [
		"TMPDIR",
		"TEMP",
		"TMP",
		"LANG",
		"LANGUAGE",
		"LC_ALL",
		"LC_CTYPE",
		"SYSTEMROOT",
		"WINDIR",
		"XDG_DATA_HOME",
		"XDG_DATA_DIRS",
		"XDG_RUNTIME_DIR",
		"FONTCONFIG_FILE",
		"FONTCONFIG_PATH",
	] as const) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return { ...environment, ...overrides };
}
