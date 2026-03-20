import { describe, expect, it } from 'vitest';
import { decodeBase64Text, normalizeWorkflowInputs } from '../src/utils';

describe('normalizeWorkflowInputs', () => {
	it('encodes instructions_json into instructions_b64', () => {
		const normalized = normalizeWorkflowInputs({
			job_id: 'job-1',
			instructions_json: {
				write_files: [
					{
						path: 'docs/test.md',
						content: '# hello\n\n- world',
					},
				],
			},
		});

		expect(typeof normalized.instructions_b64).toBe('string');
		expect(normalized.instructions_json).toBeUndefined();
		expect(JSON.parse(decodeBase64Text(String(normalized.instructions_b64)) ?? '{}')).toMatchObject({
			write_files: [
				{
					path: 'docs/test.md',
					content: '# hello\n\n- world',
				},
			],
		});
	});

	it('rejects instructions_b64 that does not decode to valid json', () => {
		const malformedJson = '{"write_files":[{"path":"docs/test.md","content":"line1\nline2"}]}';
		const malformedB64 = Buffer.from(malformedJson, 'utf8').toString('base64');

		expect(() =>
			normalizeWorkflowInputs({
				job_id: 'job-2',
				instructions_b64: malformedB64,
			}),
		).toThrow(/instructions_b64 must decode to valid JSON/);
	});
});
