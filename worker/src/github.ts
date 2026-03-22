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
	SELF_DEPLOY_ENV?: string;
	MIRROR_GITHUB_APP_ID?: string;
	MIRROR_GITHUB_APP_INSTALLATION_ID?: string;
	MIRROR_GITHUB_APP_PRIVATE_KEY_PEM?: string;
};

interface GitHubRequestOptions {
	params?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
}

interface ResolvedGitHubCredentials {
	appId: string;
	installationId: string;
	privateKeyPem: string;
	source: 'default' | 'mirror';
}

const cachedInstallationTokens = new Map<string, InstallationToken>();

export function resetGitHubAuthCache(): void {
	cachedInstallationTokens.clear();
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
	return resolveGitHubCredentials(env) !== null;
}

export function resolveGitHubCredentials(env: AppEnv): ResolvedGitHubCredentials | null {
	const deployEnv = env.SELF_DEPLOY_ENV?.trim().toLowerCase();
	const mirrorCredentialsConfigured = Boolean(
		env.MIRROR_GITHUB_APP_ID &&
			env.MIRROR_GITHUB_APP_INSTALLATION_ID &&
			env.MIRROR_GITHUB_APP_PRIVATE_KEY_PEM,
	);
	if (deployEnv === 'mirror' && mirrorCredentialsConfigured) {
		return {
			appId: String(env.MIRROR_GITHUB_APP_ID),
			installationId: String(env.MIRROR_GITHUB_APP_INSTALLATION_ID),
			privateKeyPem: String(env.MIRROR_GITHUB_APP_PRIVATE_KEY_PEM),
			source: 'mirror',
		};
	}
	if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PEM) {
		return {
			appId: env.GITHUB_APP_ID,
			installationId: env.GITHUB_APP_INSTALLATION_ID,
			privateKeyPem: env.GITHUB_APP_PRIVATE_KEY_PEM,
			source: 'default',
		};
	}
	return null;
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

export async function createInstallationToken(
	env: AppEnv,
	credentials: ResolvedGitHubCredentials,
	jwt: string,
): Promise<InstallationToken> {
	const response = await fetchWithTimeout(
		`${env.GITHUB_API_URL ?? 'https://api.github.com'}/app/installations/${credentials.installationId}/access_tokens`,
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
	const credentials = resolveGitHubCredentials(env);
	if (!credentials) {
		throw new Error('GitHub App credentials are not fully configured');
	}
	const cacheKey = `${credentials.source}:${credentials.appId}:${credentials.installationId}`;
	const cachedInstallationToken = cachedInstallationTokens.get(cacheKey) ?? null;
	if (cachedInstallationToken && !tokenExpiringSoon(cachedInstallationToken.expires_at)) {
		return cachedInstallationToken;
	}
	const jwt = await buildGitHubAppJwt(credentials.appId, credentials.privateKeyPem);
	const freshToken = await createInstallationToken(env, credentials, jwt);
	cachedInstallationTokens.set(cacheKey, freshToken);
	return freshToken;
}

function clearInstallationTokenCache(env: AppEnv): void {
	const credentials = resolveGitHubCredentials(env);
	if (!credentials) {
		return;
	}
	const cacheKey = `${credentials.source}:${credentials.appId}:${credentials.installationId}`;
	cachedInstallationTokens.delete(cacheKey);
}

export function getGitHubCredentialSource(env: AppEnv): 'default' | 'mirror' | 'unconfigured' {
	const credentials = resolveGitHubCredentials(env);
	return credentials?.source ?? 'unconfigured';
}

export function mirrorGitHubCredentialsConfigured(env: AppEnv): boolean {
	return Boolean(
		env.MIRROR_GITHUB_APP_ID &&
			env.MIRROR_GITHUB_APP_INSTALLATION_ID &&
			env.MIRROR_GITHUB_APP_PRIVATE_KEY_PEM,
	);
}

export function githubCredentialSplitConfigured(env: AppEnv): boolean {
	return githubAuthConfigured(env) && mirrorGitHubCredentialsConfigured(env);
}

export function usingMirrorGitHubCredentials(env: AppEnv): boolean {
	return getGitHubCredentialSource(env) === 'mirror';
}

export async function getResolvedGitHubAuthInfo(env: AppEnv): Promise<{
	configured: boolean;
	credential_source: 'default' | 'mirror' | 'unconfigured';
	credential_split_configured: boolean;
	using_mirror_credentials: boolean;
}> {
	return {
		configured: githubAuthConfigured(env),
		credential_source: getGitHubCredentialSource(env),
		credential_split_configured: githubCredentialSplitConfigured(env),
		using_mirror_credentials: usingMirrorGitHubCredentials(env),
	};
}

export async function githubRequest(
	env: AppEnv,
	method: string,
	path: string,
	options: GitHubRequestOptions = {}
): Promise<unknown> {
	const response = await githubRequestRaw(env, method, path, options);
	if (response.status === 204) {
		return { ok: true };
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) {
		return response.text();
	}
	return response.json();
}

export async function githubRequestRaw(
	env: AppEnv,
	method: string,
	path: string,
	options: GitHubRequestOptions = {}
): Promise<Response> {
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
			return response;
		}
		if ((response.status === 401 || response.status === 403) && attempt === 0) {
			clearInstallationTokenCache(env);
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
