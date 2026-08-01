import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeGraphvizCli {
	command: string;
	log: string;
}

export async function createFakeGraphvizCli(root: string): Promise<FakeGraphvizCli> {
	const directory = join(root, "bin");
	const log = join(root, "graphviz-log");
	const command = join(directory, "dot");
	const fixture = join(directory, "graphviz.svg");
	await Promise.all([mkdir(directory, { recursive: true }), mkdir(log, { recursive: true })]);
	await writeFile(
		fixture,
		[
			'<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
			'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"',
			' "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
			'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="40pt" viewBox="0 0 100 40">',
			'<g><path d="M5 20H95"/></g>',
			"</svg>",
		].join("\n"),
		{ mode: 0o600 },
	);
	await writeFile(
		command,
		`#!/bin/sh
if [ "$1" = "-V" ]; then
  printf '%s\n' 'dot - graphviz version 15.1.0 (fake)' >&2
  exit 0
fi
printf '%s\n' "$@" > ${shellQuote(join(log, "args"))}
output=''
source=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output=$1 ;;
    -*) ;;
    *) source=$1 ;;
  esac
  shift
done
if [ -z "$source" ] || [ -z "$output" ] || [ ! -f "$source" ]; then exit 2; fi
cp "$source" ${shellQuote(join(log, "source.dot"))}
cp ${shellQuote(fixture)} "$output"
`,
		{ mode: 0o700 },
	);
	await chmod(command, 0o700);
	return { command, log };
}

export async function readFakeGraphvizArgs(log: string): Promise<string[]> {
	return (await readFile(join(log, "args"), "utf8")).trim().split("\n").filter(Boolean);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
