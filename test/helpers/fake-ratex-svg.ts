import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeRatexSvg {
	command: string;
	log: string;
}

export interface FakeRatexInvocation {
	args: string[];
	formula: string;
	inline: boolean;
}

export async function createFakeRatexSvg(
	root: string,
	options: { embeddedFonts?: boolean } = {},
): Promise<FakeRatexSvg> {
	const directory = join(root, "bin");
	const log = join(root, "ratex-svg-log");
	const command = join(directory, "render-svg");
	await Promise.all([mkdir(directory, { recursive: true }), mkdir(log, { recursive: true })]);
	await writeFile(
		command,
		`#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\n' 'Usage: render-svg [OPTIONS]' 'This binary is currently built ${options.embeddedFonts === false ? "without" : "with"} embedded fonts.'
  exit 0
fi
printf '%s\n' "$@" > ${shellQuote(join(log, "args"))}
input=''
stdout='0'
inline='0'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) shift; input=$1 ;;
    --stdout) stdout='1' ;;
    --inline) inline='1' ;;
  esac
  shift
done
if [ -z "$input" ] || [ "$stdout" != "1" ] || [ ! -f "$input" ]; then exit 2; fi
cp "$input" ${shellQuote(join(log, "formula.tex"))}
printf '%s' "$inline" > ${shellQuote(join(log, "inline"))}
printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="44pt" viewBox="0 0 100 44"><path d="M10 10h80v24H10z" fill="rgb(0,0,0)"/></svg>'
`,
		{ mode: 0o700 },
	);
	await chmod(command, 0o700);
	return { command, log };
}

export async function readFakeRatexInvocation(path: string): Promise<FakeRatexInvocation> {
	const [args, formula, inline] = await Promise.all([
		readLines(join(path, "args")),
		readFile(join(path, "formula.tex"), "utf8"),
		readFile(join(path, "inline"), "utf8"),
	]);
	return { args, formula, inline: inline === "1" };
}

async function readLines(path: string): Promise<string[]> {
	return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
