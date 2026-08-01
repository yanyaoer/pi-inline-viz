import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandOptions {
	cwd: string;
	home: string;
	timeoutMs?: number;
	maxBufferBytes?: number;
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
			env: minimalEnvironment(options.home),
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

export async function resolveExecutable(command: string): Promise<string> {
	const candidates = command.includes("/") || command.includes("\\")
		? [resolve(command)]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.map((directory) => resolve(directory || process.cwd(), command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	throw new Error(`${command} is not executable or is not on PATH`);
}

function minimalEnvironment(home: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HOME: home,
		XDG_CACHE_HOME: home,
		NO_COLOR: "1",
	};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"] as const) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return environment;
}
