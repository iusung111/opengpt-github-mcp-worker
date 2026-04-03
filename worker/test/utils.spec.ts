import { describe, expect, it } from 'vitest';
import { resolveRepoIdentityInput, resolveUnknownRepoIdentityInput } from '../src/mcp-repo-identity';
import {
	classifyRepoPathIssue,
	buildOidcEndpointUrl,
	decodeBase64Text,
	ensureWorkflowAllowed,
	ensureLiveSelfHostControl,
	getAllowedWorkflowsByRepo,
	getEnvAllowedWorkflowsByRepo,
	getFileAllowedWorkflowsByRepo,
	getAllowedWorkflowsForRepo,
	getSelfDeployEnv,
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
				'iusung111/Project_OpenGPT': ['agent-run.yml', 'pr-merge.yml'],
				'iusung111/opengpt-github-mcp-worker': ['cloudflare-self-deploy.yml'],
				'iusung111/opengpt-github-mcp-worker-mirror-backup': ['cloudflare-self-deploy.yml'],
			}),
		};

		expect(getAllowedWorkflowsForRepo(env, 'iusung111/Project_OpenGPT')).toEqual([
			'build-todo-exe.yml',
			'opengpt-exec.yml',
			'opengpt-package.yml',
			'agent-run.yml',
			'pr-merge.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/opengpt-github-mcp-worker')).toEqual([
			'gui-capture.yml',
			'cloudflare-ci.yml',
			'opengpt-exec.yml',
			'opengpt-package.yml',
			'cloudflare-live-deploy.yml',
			'cloudflare-self-deploy.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/opengpt-github-mcp-worker-mirror-backup')).toEqual([
			'gui-capture.yml',
			'cloudflare-ci.yml',
			'opengpt-exec.yml',
			'opengpt-package.yml',
			'cloudflare-self-deploy.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/other')).toEqual(['agent-run.yml', 'pr-merge.yml']);
	});

	it('loads the repo-managed workflow allowlist config', () => {
		expect(getFileAllowedWorkflowsByRepo()).toMatchObject({
			'iusung111/Project_OpenGPT': ['build-todo-exe.yml', 'opengpt-exec.yml', 'opengpt-package.yml'],
			'iusung111/opengpt-github-mcp-worker': ['gui-capture.yml', 'cloudflare-ci.yml', 'opengpt-exec.yml', 'opengpt-package.yml', 'cloudflare-live-deploy.yml'],
			'iusung111/opengpt-github-mcp-worker-mirror-backup': ['gui-capture.yml', 'cloudflare-ci.yml', 'opengpt-exec.yml', 'opengpt-package.yml'],
		});
	});

	it('parses repo-specific workflow env config', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: JSON.stringify({
				'iusung111/Project_OpenGPT': ['agent-run.yml'],
			}),
		};

		expect(getEnvAllowedWorkflowsByRepo(env)).toEqual({
			'iusung111/Project_OpenGPT': ['agent-run.yml'],
		});
	});

	it('merges repo-managed and env repo-specific workflow allowlists', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: JSON.stringify({
				'iusung111/Project_OpenGPT': ['agent-run.yml', 'build-todo-exe.yml'],
			}),
		};

		expect(getAllowedWorkflowsByRepo(env)['iusung111/Project_OpenGPT']).toEqual([
			'build-todo-exe.yml',
			'opengpt-exec.yml',
			'opengpt-package.yml',
			'agent-run.yml',
		]);
		expect(getAllowedWorkflowsForRepo(env, 'iusung111/Project_OpenGPT')).toEqual([
			'build-todo-exe.yml',
			'opengpt-exec.yml',
			'opengpt-package.yml',
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
				'iusung111/Project_OpenGPT': ['cloudflare-live-deploy.yml'],
			}),
		};

		expect(inspectAllowedWorkflowsForRepo(env, 'iusung111/Project_OpenGPT')).toMatchObject({
			repo_key: 'iusung111/Project_OpenGPT',
			file_based_entries: ['build-todo-exe.yml', 'opengpt-exec.yml', 'opengpt-package.yml'],
			env_based_entries: ['cloudflare-live-deploy.yml'],
			env_global_fallback: ['agent-run.yml', 'pr-merge.yml'],
			effective_allowlist: ['build-todo-exe.yml', 'opengpt-exec.yml', 'opengpt-package.yml', 'cloudflare-live-deploy.yml'],
			repo_specific_match_found: true,
		});
	});

	it('throws an actionable error for malformed repo-specific workflow env config', () => {
		const env = {
			GITHUB_ALLOWED_WORKFLOWS_BY_REPO: '{"iusung111/OpenGPT":"agent-run.yml"}',
		};

		expect(() => getEnvAllowedWorkflowsByRepo(env)).toThrow(
			/GITHUB_ALLOWED_WORKFLOWS_BY_REPO\.iusung111\/Project_OpenGPT must be an array of workflow ids/,
		);
	});

	it('allows build-todo-exe.yml for iusung111/Project_OpenGPT from repo-managed config', () => {
		expect(() => ensureWorkflowAllowed({}, 'iusung111/Project_OpenGPT', 'build-todo-exe.yml')).not.toThrow();
	});

	it('rejects non-allowlisted workflows with the repo in the error message', () => {
		expect(() => ensureWorkflowAllowed({}, 'iusung111/Project_OpenGPT', 'not-allowed.yml')).toThrow(
			/workflow not allowlisted for iusung111\/Project_OpenGPT: not-allowed\.yml/,
		);
	});

	it('derives self deploy environment from current url when explicit env is absent', () => {
		const env = {
			SELF_CURRENT_URL: 'https://example-live.workers.dev/',
			SELF_LIVE_URL: 'https://example-live.workers.dev',
			SELF_MIRROR_URL: 'https://example-mirror.workers.dev',
		};

		expect(getSelfDeployEnv(env)).toBe('live');
	});

	it('blocks self-host control actions outside the live worker', () => {
		expect(() =>
			ensureLiveSelfHostControl(
				{
					SELF_DEPLOY_ENV: 'mirror',
				},
				'mirror secret sync',
			),
		).toThrow(/requires the live self-host worker/);
	});

	it('preserves issuer path segments when building OIDC endpoint URLs', () => {
		expect(buildOidcEndpointUrl('https://auth.example.com/realms/dev', '/userinfo')).toBe(
			'https://auth.example.com/realms/dev/userinfo',
		);
		expect(buildOidcEndpointUrl('https://auth.example.com', 'authorize')).toBe(
			'https://auth.example.com/authorize',
		);
	});
});

describe('resolveRepoIdentityInput', () => {
	it('accepts repo_key as the primary repo identity input', () => {
		expect(resolveRepoIdentityInput({ repo_key: 'iusung111/Project_OpenGPT' })).toEqual({
			repo_key: 'iusung111/Project_OpenGPT',
			owner: 'iusung111',
			repo: 'Project_OpenGPT',
		});
	});

	it('canonicalizes the legacy OpenGPT repo identity to Project_OpenGPT', () => {
		expect(resolveRepoIdentityInput({ repo_key: 'iusung111/OpenGPT' })).toEqual({
			repo_key: 'iusung111/Project_OpenGPT',
			owner: 'iusung111',
			repo: 'Project_OpenGPT',
		});
	});

	it('rejects mismatched repo_key and owner/repo combinations', () => {
		expect(() =>
			resolveRepoIdentityInput({
				repo_key: 'iusung111/Project_OpenGPT',
				owner: 'other',
				repo: 'Project_OpenGPT',
			}),
		).toThrow(/invalid repo identity/i);
	});

	it('returns corrective repo identity hints for non-string raw inputs', () => {
		expect(() =>
			resolveUnknownRepoIdentityInput({
				repo_key: 42,
			}),
		).toThrow(/repo_key must be a string in owner\/repo form/i);
	});
});

describe('classifyRepoPathIssue', () => {
	it('rejects absolute local filesystem paths with corrective guidance', () => {
		expect(classifyRepoPathIssue('D:\\VScode\\Project_OpenGPT\\README.md')).toMatchObject({
			kind: 'absolute',
			message: expect.stringContaining('repository-relative POSIX paths'),
		});
	});

	it('rejects non-string path inputs with a schema-gate hint', () => {
		expect(classifyRepoPathIssue(123, 'path')).toMatchObject({
			kind: 'type',
			message: expect.stringContaining('path must be a string'),
		});
	});

	it('allows repository-relative POSIX paths', () => {
		expect(classifyRepoPathIssue('worker/src/index.ts')).toBeNull();
	});
});
