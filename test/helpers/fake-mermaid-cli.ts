import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeMermaidCli {
	command: string;
	chrome: string;
	log: string;
}

export async function createFakeMermaidCli(root: string, svg = safeSvg()): Promise<FakeMermaidCli> {
	const directory = join(root, "bin");
	const log = join(root, "mermaid-log");
	const command = join(directory, "mmdc");
	const chrome = join(directory, "chrome");
	await Promise.all([mkdir(directory, { recursive: true }), mkdir(log, { recursive: true })]);
	await Promise.all([
		writeFile(
			command,
			`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' '11.16.0'
  exit 0
fi
printf '%s\n' "$@" > ${shellQuote(join(log, "args"))}
input=''
output=''
config=''
puppeteer=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) shift; input=$1 ;;
    --output) shift; output=$1 ;;
    --configFile) shift; config=$1 ;;
    --puppeteerConfigFile) shift; puppeteer=$1 ;;
  esac
  shift
done
if [ -z "$input" ] || [ -z "$output" ] || [ ! -f "$config" ] || [ ! -f "$puppeteer" ]; then exit 2; fi
cp "$input" ${shellQuote(join(log, "source.mmd"))}
cp "$config" ${shellQuote(join(log, "mermaid-config.json"))}
cp "$puppeteer" ${shellQuote(join(log, "puppeteer-config.json"))}
printf '%s\n' ${shellQuote(svg)} > "$output"
`,
			{ mode: 0o700 },
		),
		writeFile(
			chrome,
			`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' 'Fake Chrome 150.0.0.0'
  exit 0
fi
exit 2
`,
			{ mode: 0o700 },
		),
	]);
	await Promise.all([chmod(command, 0o700), chmod(chrome, 0o700)]);
	return { command, chrome, log };
}

export async function readFakeMermaidArgs(log: string): Promise<string[]> {
	return (await readFile(join(log, "args"), "utf8")).trim().split("\n").filter(Boolean);
}

function safeSvg(): string {
	return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40"><defs><marker id="arrow"><path d="M0 0L4 2L0 4z"/></marker></defs><path d="M5 20H95" marker-end="url(#arrow)"/></svg>';
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
