import { encodeKitty } from "@earendil-works/pi-tui";

const KITTY_PLACEHOLDER = String.fromCodePoint(0x10eeee);
export const MAX_KITTY_PLACEHOLDER_DIMENSION = 256;
const QUIET_QUERY = "\x1b_Ga=q,f=24,s=1,v=1,q=2;AAAA\x1b\\";

// Stable index table defined by the Kitty graphics protocol:
// https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
const DIACRITICS = `
0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357
035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484
0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1
05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658
0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2
06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743
0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819
081B 081C 081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C
082D 0951 0953 0954 0F82 0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76
1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D 1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1
1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7 1DC8 1DC9 1DCB 1DCC 1DD1
1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF 1DE0 1DE1
1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7
20E9 20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9 2DEA
2DEB 2DEC 2DED 2DEE 2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA
2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5
`
	.trim()
	.split(/\s+/u)
	.map((value) => String.fromCodePoint(Number.parseInt(value, 16)));

if (DIACRITICS.length !== MAX_KITTY_PLACEHOLDER_DIMENSION) {
	throw new Error("Kitty placeholder diacritic table must contain 256 entries");
}

export interface KittyPlaceholderOptions {
	columns: number;
	rows: number;
	imageId: number;
}

export function encodeKittyPlaceholderImage(
	base64Data: string,
	options: KittyPlaceholderOptions,
): string[] {
	validatePlaceholderOptions(options);
	return placeholderLines(virtualImageSequence(base64Data, options), options);
}

export function encodeTmuxKittyImage(
	base64Data: string,
	options: KittyPlaceholderOptions,
): string[] {
	validatePlaceholderOptions(options);
	const transfer = wrapTmuxPassthrough(virtualImageSequence(base64Data, options));
	const shield = wrapTmuxPassthrough(QUIET_QUERY);
	// Pi TUI parses only the first Kitty command on a rendered line. The quiet
	// query prevents it from later emitting an unwrapped delete through tmux.
	return placeholderLines(`${shield}${transfer}`, options);
}

function virtualImageSequence(base64Data: string, options: KittyPlaceholderOptions): string {
	return encodeKitty(base64Data, options).replace("\x1b_Ga=T,", "\x1b_Ga=T,U=1,");
}

function placeholderLines(
	transfer: string,
	options: KittyPlaceholderOptions,
): string[] {
	const color = kittyImageIdColor(options.imageId);
	const highByte = DIACRITICS[options.imageId >>> 24];
	const lines: string[] = [];

	for (let row = 0; row < options.rows; row += 1) {
		let placeholders = "";
		for (let column = 0; column < options.columns; column += 1) {
			placeholders += `${KITTY_PLACEHOLDER}${DIACRITICS[row]}${DIACRITICS[column]}${highByte}`;
		}
		lines.push(`${color}${placeholders}\x1b[39m`);
	}

	lines[0] = `${transfer}${lines[0]}`;
	return lines;
}

export function wrapTmuxPassthrough(sequence: string): string {
	const graphicsCommands = /\x1b_G.*?\x1b\\/gs;
	let matched = false;
	const wrapped = sequence.replace(graphicsCommands, (command) => {
		matched = true;
		return wrapTmuxCommand(command);
	});
	return matched ? wrapped : wrapTmuxCommand(sequence);
}

function kittyImageIdColor(imageId: number): string {
	const red = (imageId >>> 16) & 0xff;
	const green = (imageId >>> 8) & 0xff;
	const blue = imageId & 0xff;
	return `\x1b[38:2:${red}:${green}:${blue}m`;
}

function validatePlaceholderOptions(options: KittyPlaceholderOptions): void {
	for (const [name, value] of [
		["columns", options.columns],
		["rows", options.rows],
	] as const) {
		if (!Number.isInteger(value) || value < 1 || value > MAX_KITTY_PLACEHOLDER_DIMENSION) {
			throw new Error(`Kitty placeholder ${name} must be between 1 and 256`);
		}
	}
	if (!Number.isInteger(options.imageId) || options.imageId < 1 || options.imageId > 0xffffffff) {
		throw new Error("Kitty image ID must be between 1 and 4294967295");
	}
}

function wrapTmuxCommand(command: string): string {
	return `\x1bPtmux;${command.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}
