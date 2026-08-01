import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { isCommandMissing, resolveExecutable, runCommand } from "../../src/process.ts";

test("finds Linux user executables outside a restricted PATH", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-path-test-"));
	try {
		const bin = join(root, ".local", "bin");
		const executable = join(bin, "example-renderer");
		await mkdir(bin, { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		await chmod(executable, 0o700);

		assert.equal(
			await resolveExecutable("example-renderer", {
				environment: { PATH: "" },
				homeDirectory: root,
				nodeExecutable: "/missing/node",
				platform: "linux",
				cwd: root,
			}),
			executable,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("honors language and package-manager bin directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-tool-home-test-"));
	try {
		const goBin = join(root, "go-tools");
		const executable = join(goBin, "d2");
		await mkdir(goBin, { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		assert.equal(
			await resolveExecutable("d2", {
				environment: { PATH: "", GOBIN: goBin },
				homeDirectory: join(root, "home"),
				nodeExecutable: "/missing/node",
				platform: "linux",
			}),
			executable,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("expands a configured home-relative executable and marks missing commands", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-explicit-path-test-"));
	try {
		const bin = join(root, "bin");
		const executable = join(bin, "renderer");
		await mkdir(bin, { recursive: true });
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		assert.equal(
			await resolveExecutable("~/bin/renderer", { homeDirectory: root, cwd: root }),
			executable,
		);
		await assert.rejects(
			resolveExecutable("missing-renderer", {
				environment: { PATH: "" },
				homeDirectory: root,
				nodeExecutable: "/missing/node",
				platform: "linux",
			}),
			(error) => isCommandMissing(error),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps renderer resource paths while isolating HOME and cache", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-inline-viz-environment-test-"));
	const previous = {
		xdgDataHome: process.env.XDG_DATA_HOME,
		fontconfigPath: process.env.FONTCONFIG_PATH,
	};
	try {
		process.env.XDG_DATA_HOME = "/test/share";
		process.env.FONTCONFIG_PATH = "/test/fontconfig";
		const result = await runCommand(
			process.execPath,
			[
				"-e",
				"process.stdout.write(JSON.stringify({HOME:process.env.HOME,PATH:process.env.PATH,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME,XDG_DATA_HOME:process.env.XDG_DATA_HOME,FONTCONFIG_PATH:process.env.FONTCONFIG_PATH,PUPPETEER_CACHE_DIR:process.env.PUPPETEER_CACHE_DIR}))",
			],
			{
				cwd: root,
				home: root,
				environment: { PUPPETEER_CACHE_DIR: "/test/puppeteer" },
			},
		);
		const environment = JSON.parse(result.stdout) as Record<string, string>;
		assert.equal(environment.HOME, root);
		assert.ok(environment.PATH?.split(delimiter).includes(dirname(process.execPath)));
		assert.deepEqual({
			XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
			XDG_DATA_HOME: environment.XDG_DATA_HOME,
			FONTCONFIG_PATH: environment.FONTCONFIG_PATH,
			PUPPETEER_CACHE_DIR: environment.PUPPETEER_CACHE_DIR,
		}, {
			XDG_CACHE_HOME: root,
			XDG_DATA_HOME: "/test/share",
			FONTCONFIG_PATH: "/test/fontconfig",
			PUPPETEER_CACHE_DIR: "/test/puppeteer",
		});
	} finally {
		restoreEnvironment("XDG_DATA_HOME", previous.xdgDataHome);
		restoreEnvironment("FONTCONFIG_PATH", previous.fontconfigPath);
		await rm(root, { recursive: true, force: true });
	}
});

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
