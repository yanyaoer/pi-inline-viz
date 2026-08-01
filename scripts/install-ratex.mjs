#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.14";
const REPOSITORY = "erweixin/RaTeX";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const ASSETS = {
	"darwin-arm64": {
		target: "aarch64-apple-darwin",
		sha256: "efe114397c9bb7664581e5ab8464ebae1e3608af427826e6962a9817902bb5f3",
		extension: "tar.gz",
	},
	"darwin-x64": {
		target: "x86_64-apple-darwin",
		sha256: "ad94444c16a647bae8ea1d57d706aa62d813cb049b04bf3c8cdb155d3e54aa1e",
		extension: "tar.gz",
	},
	"linux-arm64": {
		target: "aarch64-unknown-linux-musl",
		sha256: "3d13f6192f2a00253a2c6bfa611df682a65414422585b4f88d41c19826d7495e",
		extension: "tar.gz",
	},
	"linux-x64": {
		target: "x86_64-unknown-linux-musl",
		sha256: "bbf0db4bcc8df7a5db360713c3dc2002b95896c97bce04e7116ed3034a05af60",
		extension: "tar.gz",
	},
	"win32-arm64": {
		target: "aarch64-pc-windows-msvc",
		sha256: "a6806d76a45495b8bbf61776a4e78baade84f3e38e2cf015545e77f5213320be",
		extension: "zip",
	},
	"win32-x64": {
		target: "x86_64-pc-windows-msvc",
		sha256: "ccb38c587c8d07589dc2e1cc5f820cca5de7631f49309d1bda4154a7a389f717",
		extension: "zip",
	},
};

async function main() {
	const asset = ASSETS[`${process.platform}-${process.arch}`];
	if (!asset) throw new Error(`RaTeX CLI is not published for ${process.platform}-${process.arch}`);

	const archiveName = `ratex-cli-v${VERSION}-${asset.target}.${asset.extension}`;
	const url = `https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${archiveName}`;
	const cacheRoot =
		process.env.PI_INLINE_VIZ_CACHE_DIR ??
		process.env.AGENT_ARTIFACT_CACHE_DIR ??
		process.env.PI_RICH_MEDIA_CACHE_DIR ??
		join(homedir(), ".cache", "pi-inline-viz");
	const executableName = process.platform === "win32" ? "render-svg.exe" : "render-svg";
	const installDirectory = join(cacheRoot, "bin");
	const destination = join(installDirectory, executableName);
	const temporary = await mkdtemp(join(tmpdir(), "pi-inline-viz-ratex-install-"));

	try {
		const archive = join(temporary, archiveName);
		const response = await fetch(url, {
			redirect: "follow",
			headers: { "user-agent": "pi-inline-viz" },
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
			throw new Error(`RaTeX archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
		}
		const archiveBytes = Buffer.from(await response.arrayBuffer());
		if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
			throw new Error(`RaTeX archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
		}
		await writeFile(archive, archiveBytes, { mode: 0o600 });
		const archiveHash = await sha256(archive);
		if (archiveHash !== asset.sha256) {
			throw new Error(`RaTeX archive checksum mismatch: expected ${asset.sha256}, got ${archiveHash}`);
		}

		const extracted = join(temporary, "extracted");
		await mkdir(extracted, { recursive: true, mode: 0o700 });
		await run("tar", ["-xf", archive, "-C", extracted]);
		const source = join(extracted, `ratex-cli-v${VERSION}-${asset.target}`, executableName);
		await chmod(source, 0o700);
		const help = await run(source, ["--help"]);
		if (!/built with embedded fonts/i.test(help.stdout)) {
			throw new Error("downloaded render-svg binary does not contain embedded fonts");
		}

		await mkdir(installDirectory, { recursive: true, mode: 0o700 });
		const staged = join(installDirectory, `.${executableName}.${process.pid}`);
		try {
			await copyFile(source, staged);
			await chmod(staged, 0o700);
			try {
				await rename(staged, destination);
			} catch (error) {
				if (!isReplaceError(error)) throw error;
				await rm(destination, { force: true });
				await rename(staged, destination);
			}
		} finally {
			await rm(staged, { force: true });
		}

		const binaryHash = await sha256(destination);
		await writeFile(
			`${destination}.metadata.json`,
			`${JSON.stringify({ version: VERSION, target: asset.target, archive_sha256: archiveHash, binary_sha256: binaryHash }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		process.stdout.write(`${JSON.stringify({ ok: true, version: VERSION, target: asset.target, path: destination, sha256: binaryHash })}\n`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

async function sha256(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
		});
	});
}

function isReplaceError(error) {
	return error?.code === "EEXIST" || error?.code === "EPERM" || error?.code === "ENOTEMPTY";
}

main().catch((error) => {
	process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	process.exitCode = 1;
});
