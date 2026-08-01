import { dirname } from "node:path";

import { configuredValue } from "../config.ts";
import { isCommandMissing, resolveExecutable, runCommand } from "../process.ts";
import type {
	Asset,
	AssetRenderer,
	AssetRenderContext,
	RendererIdentity,
} from "./types.ts";

interface RasterBackend {
	command: "rsvg-convert" | "magick";
	executable: string;
	identity: RendererIdentity;
}

export interface SvgAssetRendererOptions {
	rsvgCommand?: string;
	magickCommand?: string;
}

export class SvgAssetRenderer implements AssetRenderer {
	readonly #rsvgCommand: string;
	readonly #magickCommand: string;
	#backend: Promise<RasterBackend> | undefined;

	constructor(options: SvgAssetRendererOptions = {}) {
		this.#rsvgCommand =
			options.rsvgCommand ?? configuredValue(["PI_INLINE_VIZ_RSVG_COMMAND"]) ?? "rsvg-convert";
		this.#magickCommand =
			options.magickCommand ?? configuredValue(["PI_INLINE_VIZ_MAGICK_COMMAND"]) ?? "magick";
	}

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
				backend.executable,
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
				backend.executable,
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
			const executable = await resolveExecutable(this.#rsvgCommand);
			const result = await runCommand(executable, ["--version"], {
				cwd: process.cwd(),
				home: process.cwd(),
				timeoutMs: 2_000,
			});
			return {
				command: "rsvg-convert",
				executable,
				identity: {
					id: "rsvg-convert",
					version: result.stdout.trim() || result.stderr.trim() || "unknown",
				},
			};
		} catch (error) {
			if (!isCommandMissing(error)) throw error;
		}

		try {
			const executable = await resolveExecutable(this.#magickCommand);
			const result = await runCommand(executable, ["--version"], {
				cwd: process.cwd(),
				home: process.cwd(),
				timeoutMs: 2_000,
			});
			return {
				command: "magick",
				executable,
				identity: {
					id: "magick",
					version: (result.stdout.trim() || result.stderr.trim() || "unknown").split("\n")[0] ?? "unknown",
				},
			};
		} catch (error) {
			if (isCommandMissing(error)) {
				throw new Error("SVG rasterization requires rsvg-convert or ImageMagick's magick command; set PI_INLINE_VIZ_RSVG_COMMAND or PI_INLINE_VIZ_MAGICK_COMMAND for a custom path", {
					cause: error,
				});
			}
			throw error;
		}
	}
}
