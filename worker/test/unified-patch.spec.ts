import { describe, expect, it } from 'vitest';
import { applyUnifiedPatch, parseUnifiedPatch } from '../src/unified-patch';

describe('unified patch helpers', () => {
	it('parses hunks from unified diff text', () => {
		const hunks = parseUnifiedPatch([
			'@@ -1,2 +1,2 @@',
			' line one',
			'-line two',
			'+line 2',
		].join('\n'));

		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toMatchObject({
			old_start: 1,
			new_start: 1,
		});
		expect(hunks[0].lines).toHaveLength(3);
	});

	it('applies a unified patch to text', () => {
		const result = applyUnifiedPatch(
			['line one', 'line two', 'line three', ''].join('\n'),
			['@@ -1,3 +1,3 @@', ' line one', '-line two', '+line 2', ' line three'].join('\n'),
		);

		expect(result.ok).toBe(true);
		expect(result.text).toBe(['line one', 'line 2', 'line three', ''].join('\n'));
		expect(result.additions).toBe(1);
		expect(result.deletions).toBe(1);
	});

	it('reports deterministic conflicts when patch context does not match', () => {
		const result = applyUnifiedPatch(
			['line one', 'line two'].join('\n'),
			['@@ -1,2 +1,2 @@', ' line zero', '-line two', '+line 2'].join('\n'),
		);

		expect(result.ok).toBe(false);
		expect(result.conflict).toMatchObject({
			line_number: 1,
			expected: 'line zero',
			actual: 'line one',
		});
	});
});
