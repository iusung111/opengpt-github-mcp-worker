import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitBatchWriteChanges, prepareBatchWriteChanges, preparePatchsetChanges } from '../src/repo-batch-write';
import { resetGitHubAuthCache } from '../src/github';

afterEach(() => {
	resetGitHubAuthCache();
	vi.restoreAllMocks();
});

function makeEnv(): Env {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	return {
		GITHUB_API_URL: 'https://api.github.test',
		GITHUB_APP_ID: '123',
		GITHUB_APP_INSTALLATION_ID: '456',
		GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
	} as Env;
}

describe('repo batch write helpers', () => {
	it('prepares rename and scaffold changes against the current branch tree', async () => {
		const env = makeEnv();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url === 'https://api.github.test/app/installations/456/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'token-1',
						expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/ref/heads/agent/desktop-feature') {
				return new Response(JSON.stringify({ object: { sha: 'base-ref-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/trees/agent%2Fdesktop-feature?recursive=true') {
				return new Response(
					JSON.stringify({
						tree: [
							{ path: 'src/app.tsx', sha: 'blob-app-old', mode: '100644', type: 'blob' },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/contents/src/app.tsx?ref=agent%2Fdesktop-feature') {
				return new Response(JSON.stringify({ type: 'file', sha: 'blob-app-old', content: btoa('old') }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/contents/src/ui/app.tsx?ref=agent%2Fdesktop-feature') {
				return new Response('not found', { status: 404 });
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/contents/src/ui/.gitkeep?ref=agent%2Fdesktop-feature') {
				return new Response('not found', { status: 404 });
			}
			return new Response('not found', { status: 404 });
		});

		const prepared = await prepareBatchWriteChanges(env as never, {
			owner: 'iusung111',
			repo: 'OpenGPT',
			branch: 'agent/desktop-feature',
			operations: [
				{
					type: 'rename_path',
					from_path: 'src/app.tsx',
					to_path: 'src/ui/app.tsx',
					expected_blob_sha: 'blob-app-old',
				},
				{
					type: 'mkdir_scaffold',
					path: 'src/ui',
				},
			],
		});

		expect(prepared.base_ref_sha).toBe('base-ref-sha');
		expect(prepared.changes).toMatchObject([
			{ path: 'src/app.tsx', action: 'delete', previous_blob_sha: 'blob-app-old' },
			{ path: 'src/ui/app.tsx', action: 'rename', previous_path: 'src/app.tsx' },
			{ path: 'src/ui/.gitkeep', action: 'mkdir_scaffold' },
		]);
	});

	it('prepares a text patchset and returns parsed hunk preview', async () => {
		const env = makeEnv();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url === 'https://api.github.test/app/installations/456/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'token-1',
						expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/ref/heads/agent/desktop-feature') {
				return new Response(JSON.stringify({ object: { sha: 'base-ref-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/trees/agent%2Fdesktop-feature?recursive=true') {
				return new Response(
					JSON.stringify({
						tree: [{ path: 'README.md', sha: 'blob-readme', mode: '100644', type: 'blob' }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/contents/README.md?ref=agent%2Fdesktop-feature') {
				return new Response(
					JSON.stringify({
						type: 'file',
						sha: 'blob-readme',
						content: btoa('# OpenGPT\nold line\n'),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response('not found', { status: 404 });
		});

		const prepared = await preparePatchsetChanges(env as never, {
			owner: 'iusung111',
			repo: 'OpenGPT',
			branch: 'agent/desktop-feature',
			patches: [
				{
					path: 'README.md',
					expected_blob_sha: 'blob-readme',
					patch_unified: ['@@ -1,2 +1,2 @@', ' # OpenGPT', '-old line', '+new line'].join('\n'),
				},
			],
		});

		expect(prepared.preview[0]).toMatchObject({
			path: 'README.md',
			action: 'update',
			additions: 1,
			deletions: 1,
		});
		expect(prepared.changes[0].content_b64).toBe(btoa('# OpenGPT\nnew line\n'));
	});

	it('commits prepared batch changes through the git data APIs', async () => {
		const env = makeEnv();
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === 'https://api.github.test/app/installations/456/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'token-1',
						expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/ref/heads/agent%2Fdesktop-feature') {
				return new Response(JSON.stringify({ object: { sha: 'base-ref-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/commits/base-ref-sha') {
				return new Response(JSON.stringify({ tree: { sha: 'tree-base-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/blobs') {
				return new Response(JSON.stringify({ sha: 'blob-new-sha' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/trees') {
				return new Response(JSON.stringify({ sha: 'tree-new-sha' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/commits' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
				return new Response(JSON.stringify({ sha: 'commit-new-sha' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/refs/heads/agent/desktop-feature') {
				return new Response(JSON.stringify({ ref: 'refs/heads/agent/desktop-feature', object: { sha: 'commit-new-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response('not found', { status: 404 });
		});

		const result = await commitBatchWriteChanges(env as never, {
			owner: 'iusung111',
			repo: 'OpenGPT',
			branch: 'agent/desktop-feature',
			message: 'Apply batch write',
			base_ref_sha: 'base-ref-sha',
			changes: [
				{
					path: 'README.md',
					action: 'update',
					mode: '100644',
					type: 'blob',
					content_b64: btoa('# OpenGPT\n'),
					previous_blob_sha: 'blob-old',
					previous_path: null,
				},
			],
		});

		expect(result).toMatchObject({
			commit: {
				sha: 'commit-new-sha',
				parent_sha: 'base-ref-sha',
			},
			changed_files: [{ path: 'README.md', action: 'update' }],
		});
		expect(fetchMock).toHaveBeenCalled();
	});
});
