import { createSign } from 'node:crypto';

export interface InstallationToken {
	token: string;
	expires_at: string;
}

const USER_AGENT = 'opengpt-github-mcp-worker';
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

type AppEnv = Env & {
	GITHUB_APP_PRIVATE_KEY_PEM?: string;
	GITHUB_API_URL?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
};

interface GitHubRequestOptions {
	params?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
}

let cachedInstallationToken: InstallationToken | null = null;

export function resetGitHubAuthCache(): void {
	cachedInstallationToken = null;
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort('github_timeout'), GITHUB_FETCH_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

function toBase64Url(bytes: Uint8Array): string {
	let base64 = '';
	for (const byte of bytes) {
		base64 += String.fromCharCode(byte);
	}
	return btoa(base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8Base64Url(value: string): string {
	return toBase64Url(new TextEncoder().encode(value));
}

function tokenExpiringSoon(expiresAt: string): boolean {
	return Date.parse(expiresAt) - Date.now() < 120_000;
}

export function githubAuthConfigured(env: AppEnv): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PEM);
}

export async function buildGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
	const header = { alg: 'RS256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		iat: now - 60,
		exp: now + 9 * 60,
		iss: appId,
	};

	const signingInput = `${utf8Base64Url(JSON.stringify(header))}.${utf8Base64Url(JSON.stringify(payload))}`;
	const signer = createSign('RSA-SHA256');
	signer.update(signingInput);
	signer.end();
	const signature = signer.sign(privateKeyPem);
	return `${signingInput}.${signature.toString('base64url')}`;
}

export async function createInstallationToken(env: AppEnv, jwt: string): Promise<InstallationToken> {
	const response = await fetchWithTimeout(
		`${env.GITHUB_API_URL ?? 'https://api.github.com'}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
		{
			method: 'POST',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${jwt}`,
				'User-Agent': USER_AGENT,
				'X-GitHub-Api-Version': '2022-11-28',
			},
		},
	);
	if (!response.ok) {
		const message = await response.text();
		throw new Error(`failed to create installation token: ${response.status} ${message}`.trim());
	}
	return (await response.json()) as InstallationToken;
}

export async function getInstallationToken(env: AppEnv): Promise<InstallationToken> {
	if (!githubAuthConfigured(env)) {
		throw new Error('GitHub App credentials are not fully configured');
	}
	if (cachedInstallationToken && !tokenExpiringSoon(cachedInstallationToken.expires_at)) {
		return cachedInstallationToken;
	}
	const appId = env.GITHUB_APP_ID;
	const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY_PEM;
	if (!appId || !privateKeyPem) {
		throw new Error('GitHub App credentials are not fully configured');
	}
	const jwt = await buildGitHubAppJwt(appId, privateKeyPem);
	cachedInstallationToken = await createInstallationToken(env, jwt);
	return cachedInstallationToken;
}

export async function githubRequest(
	env: AppEnv,
	method: string,
	path: string,
	options: GitHubRequestOptions = {}
): Promise<unknown> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const installationToken = await getInstallationToken(env);
		const url = new URL(path, env.GITHUB_API_URL ?? 'https://api.github.com');
		for (const [key, value] of Object.entries(options.params ?? {})) {
			if (value === undefined) {
				continue;
			}
			url.searchParams.set(key, String(value));
		}
		const response = await fetchWithTimeout(url.toString(), {
			method,
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${installationToken.token}`,
				'User-Agent': USER_AGENT,
				'X-GitHub-Api-Version': '2022-11-28',
				...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
				...options.headers,
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		if (response.ok) {
			if (response.status === 204) {
				return { ok: true };
			}
			const contentType = response.headers.get('content-type') ?? '';
			if (!contentType.includes('application/json')) {
				return response.text();
			}
			return response.json();
		}
		if ((response.status === 401 || response.status === 403) && attempt === 0) {
			cachedInstallationToken = null;
			continue;
		}
		const message = await response.text();
		throw new Error(`github request failed: ${response.status} ${message}`.trim());
	}
	throw new Error('github request failed: exhausted retries');
}

export async function githubGet(
	env: AppEnv,
	path: string,
	options: Omit<GitHubRequestOptions, 'body'> = {}
): Promise<unknown> {
	return githubRequest(env, 'GET', path, options);
}

export async function githubPost(env: AppEnv, path: string, body?: unknown): Promise<unknown> {
	return githubRequest(env, 'POST', path, { body });
}

export async function githubPut(env: AppEnv, path: string, body?: unknown): Promise<unknown> {
	return githubRequest(env, 'PUT', path, { body });
}

export async function githubDelete(env: AppEnv, path: string): Promise<unknown> {
	return githubRequest(env, 'DELETE', path);
}
