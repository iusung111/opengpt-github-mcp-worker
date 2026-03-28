export type UnifiedPatchLineKind = 'context' | 'add' | 'del';

export interface UnifiedPatchLine {
	kind: UnifiedPatchLineKind;
	text: string;
}

export interface UnifiedPatchHunk {
	header: string;
	old_start: number;
	old_count: number;
	new_start: number;
	new_count: number;
	lines: UnifiedPatchLine[];
}

export interface UnifiedPatchConflict {
	hunk_header: string;
	line_number: number;
	expected: string;
	actual: string | null;
}

export interface UnifiedPatchApplyResult {
	ok: boolean;
	hunks: UnifiedPatchHunk[];
	additions: number;
	deletions: number;
	text?: string;
	conflict?: UnifiedPatchConflict;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function splitNormalizedLines(value: string): { lines: string[]; trailing_newline: boolean } {
	const normalized = value.replace(/\r\n/g, '\n');
	if (!normalized) {
		return { lines: [], trailing_newline: false };
	}
	const trailingNewline = normalized.endsWith('\n');
	const lines = normalized.split('\n');
	if (trailingNewline) {
		lines.pop();
	}
	return { lines, trailing_newline: trailingNewline };
}

export function parseUnifiedPatch(patchText: string): UnifiedPatchHunk[] {
	const lines = patchText.replace(/\r\n/g, '\n').split('\n');
	const hunks: UnifiedPatchHunk[] = [];
	let current: UnifiedPatchHunk | null = null;

	for (const rawLine of lines) {
		if (!current) {
			const headerMatch = rawLine.match(HUNK_HEADER_PATTERN);
			if (!headerMatch) {
				continue;
			}
			current = {
				header: rawLine,
				old_start: Number(headerMatch[1]),
				old_count: headerMatch[2] ? Number(headerMatch[2]) : 1,
				new_start: Number(headerMatch[3]),
				new_count: headerMatch[4] ? Number(headerMatch[4]) : 1,
				lines: [],
			};
			hunks.push(current);
			continue;
		}

		const nextHeaderMatch = rawLine.match(HUNK_HEADER_PATTERN);
		if (nextHeaderMatch) {
			current = {
				header: rawLine,
				old_start: Number(nextHeaderMatch[1]),
				old_count: nextHeaderMatch[2] ? Number(nextHeaderMatch[2]) : 1,
				new_start: Number(nextHeaderMatch[3]),
				new_count: nextHeaderMatch[4] ? Number(nextHeaderMatch[4]) : 1,
				lines: [],
			};
			hunks.push(current);
			continue;
		}

		if (rawLine === '\\ No newline at end of file') {
			continue;
		}
		const prefix = rawLine[0];
		if (prefix === ' ' || prefix === '+' || prefix === '-') {
			current.lines.push({
				kind: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'del',
				text: rawLine.slice(1),
			});
		}
	}

	return hunks;
}

export function applyUnifiedPatch(originalText: string, patchText: string): UnifiedPatchApplyResult {
	const hunks = parseUnifiedPatch(patchText);
	if (hunks.length === 0) {
		return {
			ok: false,
			hunks: [],
			additions: 0,
			deletions: 0,
			conflict: {
				hunk_header: 'missing_hunks',
				line_number: 0,
				expected: 'at least one @@ hunk header',
				actual: null,
			},
		};
	}

	const { lines: originalLines, trailing_newline } = splitNormalizedLines(originalText);
	const lineEnding = originalText.includes('\r\n') ? '\r\n' : '\n';
	const output: string[] = [];
	let sourceIndex = 0;
	let additions = 0;
	let deletions = 0;

	for (const hunk of hunks) {
		const expectedStartIndex = hunk.old_start > 0 ? hunk.old_start - 1 : 0;
		if (expectedStartIndex < sourceIndex) {
			return {
				ok: false,
				hunks,
				additions,
				deletions,
				conflict: {
					hunk_header: hunk.header,
					line_number: expectedStartIndex + 1,
					expected: 'non-overlapping hunk start',
					actual: String(sourceIndex + 1),
				},
			};
		}
		output.push(...originalLines.slice(sourceIndex, expectedStartIndex));
		let cursor = expectedStartIndex;

		for (const line of hunk.lines) {
			if (line.kind === 'add') {
				output.push(line.text);
				additions += 1;
				continue;
			}

			const actualLine = cursor < originalLines.length ? originalLines[cursor] : null;
			if (actualLine !== line.text) {
				return {
					ok: false,
					hunks,
					additions,
					deletions,
					conflict: {
						hunk_header: hunk.header,
						line_number: cursor + 1,
						expected: line.text,
						actual: actualLine,
					},
				};
			}

			if (line.kind === 'context') {
				output.push(actualLine);
			} else {
				deletions += 1;
			}
			cursor += 1;
		}

		sourceIndex = cursor;
	}

	output.push(...originalLines.slice(sourceIndex));
	const rebuilt = output.join(lineEnding);
	const text = rebuilt.length === 0 ? '' : trailing_newline ? `${rebuilt}${lineEnding}` : rebuilt;
	return {
		ok: true,
		hunks,
		additions,
		deletions,
		text,
	};
}
