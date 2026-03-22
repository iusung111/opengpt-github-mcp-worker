import { describe, expect, it } from 'vitest';
import { decodeBase64Text, getAllowedWorkflowsForRepo, normalizeWorkflowInputs } from '../src/utils';

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

	it('accepts pr-merge workflow_dispatch inputs', () => {
		const normalized = normalizeWorkflowInputs({
			pull_number: '29',
			merge_method: 'squash',
			delete_branch: true,
		});

		expect(normalized).toMatchObject({
			pull_number: '29',
			merge_method: 'squash',
			delete_branch: true,
		});
	});

	it('uses repo-specific workflow allowlists when configured', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS: 'agent-run.yml,pr-merge.yml',
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: JSON.stringify({
				'iusung111/OpenGPT': ['agent-run.yml', 'pr-merge.yml'],
				'iusung111/opengpt-github-mcp-worker': ['cloudflare-self-deploy.yml'],
			}),
		};

		expect(getAllowedWorkflowsForRepo(env, 'iusung111/OpenGPT')).toEqual(['agent-run.yml', 'pr-merge.yml']);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/opengpt-github-mcp-worker')).toEqual([
			'cloudflare-self-deploy.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/other')).toEqual(['agent-run.yml', 'pr-merge.yml']);
	});
});
