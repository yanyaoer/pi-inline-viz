import { dirname } from "node:path";

import { isCommandMissing, runCommand } from "../process.ts";
import type {
	Asset,
	AssetRenderer,
	AssetRenderContext,
	RendererIdentity,
} from "./types.ts";

interface RasterBackend {
	command: "rsvg-convert" | "magick";
	identity: RendererIdentity;
}

export class SvgAssetRenderer implements AssetRenderer {
	#backend: Promise<RasterBackend> | undefined;

	async getIdentity(): Promise<RendererIdentity> {
		return (await this.#getBackend()).identity;
	}

	async render(asset: Asset, context: AssetRenderContext): Promise<Asset> {
		if (asset.format !== "svg") {
			throw new Error(`SVG asset renderer cannot process ${asset.format}`);
		}
		const backend = await this.#getBackend();
		const commandOptions = {
			cwd: dirname(context.outputPath),
			home: dirname(context.outputPath),
			timeoutMs: context.policy.timeoutMs,
		};
		if (backend.command === "rsvg-convert") {
			await runCommand(
				backend.command,
				[
					"--dpi-x",
					String(context.profile.dpi),
					"--dpi-y",
					String(context.profile.dpi),
					"--zoom",
					String(context.profile.scale),
					"--background-color",
					context.profile.background,
					"--output",
					context.outputPath,
					asset.path,
				],
				commandOptions,
			);
		} else {
			const background =
				context.profile.background === "transparent"
					? ["-background", "none"]
					: ["-background", context.profile.background, "-alpha", "remove", "-alpha", "off"];
			await runCommand(
				backend.command,
				[
					"-density",
					`${context.profile.dpi}x${context.profile.dpi}`,
					asset.path,
					"-resize",
					`${context.profile.scale * 100}%`,
					...background,
					context.outputPath,
				],
				commandOptions,
			);
		}
		return { format: "png", mediaType: "image/png", path: context.outputPath };
	}

	#getBackend(): Promise<RasterBackend> {
		this.#backend ??= this.#detectBackend();
		return this.#backend;
	}

	async #detectBackend(): Promise<RasterBackend> {
		try {
			const result = await runCommand("rsvg-convert", ["--version"], {
				cwd: process.cwd(),
				home: process.cwd(),
				timeoutMs: 2_000,
			});
			return {
				command: "rsvg-convert",
				identity: {
					id: "rsvg-convert",
					version: result.stdout.trim() || result.stderr.trim() || "unknown",
				},
			};
		} catch (error) {
			if (!isCommandMissing(error)) throw error;
		}

		try {
			const result = await runCommand("magick", ["--version"], {
				cwd: process.cwd(),
				home: process.cwd(),
				timeoutMs: 2_000,
			});
			return {
				command: "magick",
				identity: {
					id: "magick",
					version: (result.stdout.trim() || result.stderr.trim() || "unknown").split("\n")[0] ?? "unknown",
				},
			};
		} catch (error) {
			if (isCommandMissing(error)) {
				throw new Error("SVG rasterization requires rsvg-convert or ImageMagick's magick command", {
					cause: error,
				});
			}
			throw error;
		}
	}
}
