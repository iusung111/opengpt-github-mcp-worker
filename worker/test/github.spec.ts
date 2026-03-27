import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGitHubAppJwt, githubAuthConfigured, githubGet, githubPut, resetGitHubAuthCache } from '../src/github';
import { commitUploadedFile, inspectFileAtBranch } from '../src/github-file-commit';

afterEach(() => {
	resetGitHubAuthCache();
	vi.restoreAllMocks();
});

describe('github auth helpers', () => {
	it('reports auth configured only when required env vars exist', () => {
		const env = {
			GITHUB_APP_ID: '123',
			GITHUB_APP_INSTALLATION_ID: '456',
			GITHUB_APP_PRIVATE_KEY_PEM: 'pem',
		} as Env;
		expect(githubAuthConfigured(env)).toBe(true);
		expect(githubAuthConfigured({} as Env)).toBe(false);
	});

	it('builds jwt-like token with three segments from PKCS8 pem', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const token = await buildGitHubAppJwt('123', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
		expect(token.split('.')).toHaveLength(3);
	});

	it('builds jwt-like token with three segments from RSA PKCS1 pem', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const token = await buildGitHubAppJwt('123', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
		expect(token.split('.')).toHaveLength(3);
	});

	it('retries once after auth failure and refreshes installation token', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: 'token-1',
						expires_at: new Date(Date.now() + 60_000).toISOString(),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
			)
			.mockResolvedValueOnce(new Response('expired', { status: 401 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: 'token-2',
						expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);

		const result = await githubGet(
			{
				GITHUB_API_URL: 'https://api.github.test',
				GITHUB_APP_ID: '123',
				GITHUB_APP_INSTALLATION_ID: '456',
				GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
			} as Env,
			'/repos/iusung111/OpenGPT',
		);

		expect(result).toMatchObject({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it('sends JSON payloads for githubPut requests', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: 'token-1',
						expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ merged: true, sha: 'merged-sha' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);

		const result = await githubPut(
			{
				GITHUB_API_URL: 'https://api.github.test',
				GITHUB_APP_ID: '123',
				GITHUB_APP_INSTALLATION_ID: '456',
				GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
			} as Env,
			'/repos/iusung111/OpenGPT/pulls/6/merge',
			{ merge_method: 'squash', commit_title: 'Merge PR #6' },
		);

		expect(result).toMatchObject({ merged: true, sha: 'merged-sha' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const requestInit = fetchMock.mock.calls[1]?.[1];
		expect(requestInit?.method).toBe('PUT');
		expect(requestInit?.body).toBe(JSON.stringify({ merge_method: 'squash', commit_title: 'Merge PR #6' }));
	});

	it('inspects and commits uploaded files through git data APIs', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const env = {
			GITHUB_API_URL: 'https://api.github.test',
			GITHUB_APP_ID: '123',
			GITHUB_APP_INSTALLATION_ID: '456',
			GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
		} as Env;
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
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/ref/heads/agent/upload-test') {
				return new Response(JSON.stringify({ object: { sha: 'base-ref-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/contents/README.md?ref=agent%2Fupload-test') {
				return new Response(JSON.stringify({ type: 'file', sha: 'blob-old-sha' }), {
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
			if (url === 'https://api.github.test/repos/iusung111/OpenGPT/git/refs/heads/agent/upload-test') {
				return new Response(JSON.stringify({ ref: 'refs/heads/agent/upload-test', object: { sha: 'commit-new-sha' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response('not found', { status: 404 });
		});

		const inspection = await inspectFileAtBranch(env, 'iusung111', 'OpenGPT', 'agent/upload-test', 'README.md');
		expect(inspection).toEqual({ ref_sha: 'base-ref-sha', blob_sha: 'blob-old-sha' });

		const result = await commitUploadedFile(env, {
			owner: 'iusung111',
			repo: 'OpenGPT',
			branch: 'agent/upload-test',
			path: 'README.md',
			message: 'Upload README via stream',
			content_b64: btoa('# OpenGPT\n'),
			base_ref_sha: 'base-ref-sha',
			expected_blob_sha: 'blob-old-sha',
		});

		expect(result).toMatchObject({
			content: {
				path: 'README.md',
				sha: 'blob-new-sha',
			},
			commit: {
				sha: 'commit-new-sha',
				parent_sha: 'base-ref-sha',
			},
			previous_blob_sha: 'blob-old-sha',
		});
		expect(fetchMock).toHaveBeenCalled();
	});
});
