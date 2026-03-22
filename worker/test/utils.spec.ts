import { describe, expect, it } from 'vitest';
import {
	decodeBase64Text,
	ensureWorkflowAllowed,
	getAllowedWorkflowsByRepo,
	getEnvAllowedWorkflowsByRepo,
	getFileAllowedWorkflowsByRepo,
	getAllowedWorkflowsForRepo,
	inspectAllowedWorkflowsForRepo,
	normalizeWorkflowInputs,
} from '../src/utils';

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

		expect(getAllowedWorkflowsForRepo(env, 'iusung111/OpenGPT')).toEqual([
			'build-todo-exe.yml',
			'agent-run.yml',
			'pr-merge.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/opengpt-github-mcp-worker')).toEqual([
			'cloudflare-self-deploy.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/other')).toEqual(['agent-run.yml', 'pr-merge.yml']);
	});

	it('loads the repo-managed workflow allowlist config', () => {
		expect(getFileAllowedWorkflowsByRepo()).toMatchObject({
			'iusung111/OpenGPT': ['build-todo-exe.yml'],
		});
	});

	it('parses repo-specific workflow env config', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: JSON.stringify({
				'iusung111/OpenGPT': ['agent-run.yml'],
			}),
		};

		expect(getEnvAllowedWorkflowsByRepo(env)).toEqual({
			'iusung111/OpenGPT': ['agent-run.yml'],
		});
	});

	it('merges repo-managed and env repo-specific workflow allowlists', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: JSON.stringify({
				'iusung111/OpenGPT': ['agent-run.yml', 'build-todo-exe.yml'],
			}),
		};

		expect(getAllowedWorkflowsByRepo(env)['iusung111/OpenGPT']).toEqual([
			'build-todo-exe.yml',
			'agent-run.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/OpenGPT')).toEqual([
			'build-todo-exe.yml',
			'agent-run.yml',
		]);
	});

	it('falls back to the global env allowlist when no repo-specific match exists', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS: 'agent-run.yml,pr-merge.yml',
		};

		expect(getAllowedWorkflowsForRepo(env, 'iusung111/other')).toEqual(['agent-run.yml', 'pr-merge.yml']);
	});

	it('returns effective workflow allowlist inspection details for a repo', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS: 'agent-run.yml,pr-merge.yml',
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: JSON.stringify({
				'iusung111/OpenGPT': ['cloudflare-live-deploy.yml'],
			}),
		};

		expect(inspectAllowedWorkflowsForRepo(env, 'iusung111/OpenGPT')).toMatchObject({
			repo_key: 'iusung111/OpenGPT',
			file_based_entries: ['build-todo-exe.yml'],
			env_based_entries: ['cloudflare-live-deploy.yml'],
			env_global_fallback: ['agent-run.yml', 'pr-merge.yml'],
			effective_allowlist: ['build-todo-exe.yml', 'cloudflare-live-deploy.yml'],
			repo_specific_match_found: true,
		});
	});

	it('throws an actionable error for malformed repo-specific workflow env config', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: '{"iusung111/OpenGPT":"agent-run.yml"}',
		};

		expect(() => getEnvAllowedWorkflowsByRepo(env)).toThrow(
			/GITHUB_ALLOWED_WORKFLOWS_BY_REPO\.iusung111\/OpenGPT must be an array of workflow ids/,
		);
	});

	it('allows build-todo-exe.yml for iusung111/OpenGPT from repo-managed config', () => {
		expect(() => ensureWorkflowAllowed({}, 'iusung111/OpenGPT', 'build-todo-exe.yml')).not.toThrow();
	});

	it('rejects non-allowlisted workflows with the repo in the error message', () => {
		expect(() => ensureWorkflowAllowed({}, 'iusung111/OpenGPT', 'not-allowed.yml')).toThrow(
			/workflow not allowlisted for iusung111\/OpenGPT: not-allowed\.yml/,
		);
});
