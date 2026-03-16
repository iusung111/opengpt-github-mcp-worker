import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGitHubAppJwt, githubAuthConfigured, githubGet } from '../src/github';

afterEach(() => {
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
});
