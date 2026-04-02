import { createSign } from 'node:crypto';
import type { InstallationToken, GitHubEnv, ResolvedGitHubCredentials } from './types';

const USER_AGENT = 'opengpt-github-mcp-worker';
const GITHUB_FETCH_TIMEOUT_MS = 30_000;
const cachedInstallationTokens = new Map<string, InstallationToken>();

export function resetGitHubAuthCache(): void {
	cachedInstallationTokens.clear();
}

export async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
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
	for (const byte of bytes) base64 += String.fromCharCode(byte);
	return btoa(base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8Base64Url(value: string): string {
	return toBase64Url(new TextEncoder().encode(value));
}

function tokenExpiringSoon(expiresAt: string): boolean {
	return Date.parse(expiresAt) - Date.now() < 120_000;
}

export function resolveGitHubCredentials(env: GitHubEnv): ResolvedGitHubCredentials | null {
	const deployEnv = env.SELF_DEPLOY_ENV?.trim().toLowerCase();
	const mirrorCredentialsConfigured = Boolean(env.MIRROR_GITHUB_APP_ID && env.MIRROR_GITHUB_APP_INSTALLATION_ID && env.MIRROR_GITHUB_APP_PRIVATE_KEY_PEM);
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

export function githubAuthConfigured(env: GitHubEnv): boolean {
	return resolveGitHubCredentials(env) !== null;
}

export async function buildGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
	const header = { alg: 'RS256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
	const signingInput = `${utf8Base64Url(JSON.stringify(header))}.${utf8Base64Url(JSON.stringify(payload))}`;
	const signer = createSign('RSA-SHA256');
	signer.update(signingInput);
	signer.end();
	const signature = signer.sign(privateKeyPem);
	return `${signingInput}.${signature.toString('base64url')}`;
}

async function createInstallationToken(env: GitHubEnv, credentials: ResolvedGitHubCredentials, jwt: string): Promise<InstallationToken> {
	const response = await fetchWithTimeout(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/app/installations/${credentials.installationId}/access_tokens`, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${jwt}`,
			'User-Agent': USER_AGENT,
			'X-GitHub-Api-Version': '2022-11-28',
		},
	});
	if (!response.ok) {
		const message = await response.text();
		throw new Error(`failed to create installation token: ${response.status} ${message}`.trim());
	}
	return (await response.json()) as InstallationToken;
}

export async function getInstallationToken(env: GitHubEnv): Promise<InstallationToken> {
	const credentials = resolveGitHubCredentials(env);
	if (!credentials) throw new Error('GitHub App credentials are not fully configured');
	const cacheKey = `${credentials.source}:${credentials.appId}:${credentials.installationId}`;
	const cachedInstallationToken = cachedInstallationTokens.get(cacheKey) ?? null;
	if (cachedInstallationToken && !tokenExpiringSoon(cachedInstallationToken.expires_at)) return cachedInstallationToken;
	const jwt = await buildGitHubAppJwt(credentials.appId, credentials.privateKeyPem);
	const freshToken = await createInstallationToken(env, credentials, jwt);
	cachedInstallationTokens.set(cacheKey, freshToken);
	return freshToken;
}

export function clearInstallationTokenCache(env: GitHubEnv): void {
	const credentials = resolveGitHubCredentials(env);
	if (!credentials) return;
	cachedInstallationTokens.delete(`${credentials.source}:${credentials.appId}:${credentials.installationId}`);
}

export function getGitHubCredentialSource(env: GitHubEnv): 'default' | 'mirror' | 'unconfigured' {
	return resolveGitHubCredentials(env)?.source ?? 'unconfigured';
}

export function mirrorGitHubCredentialsConfigured(env: GitHubEnv): boolean {
	return Boolean(env.MIRROR_GITHUB_APP_ID && env.MIRROR_GITHUB_APP_INSTALLATION_ID && env.MIRROR_GITHUB_APP_PRIVATE_KEY_PEM);
}

export function githubCredentialSplitConfigured(env: GitHubEnv): boolean {
	return githubAuthConfigured(env) && mirrorGitHubCredentialsConfigured(env);
}

export function usingMirrorGitHubCredentials(env: GitHubEnv): boolean {
	return getGitHubCredentialSource(env) === 'mirror';
}

export async function getResolvedGitHubAuthInfo(env: GitHubEnv): Promise<{ configured: boolean; credential_source: 'default' | 'mirror' | 'unconfigured'; credential_split_configured: boolean; using_mirror_credentials: boolean }> {
	return {
		configured: githubAuthConfigured(env),
		credential_source: getGitHubCredentialSource(env),
		credential_split_configured: githubCredentialSplitConfigured(env),
		using_mirror_credentials: usingMirrorGitHubCredentials(env),
	};
}

export { USER_AGENT };
