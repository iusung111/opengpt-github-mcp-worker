import { createSign } from 'node:crypto';
import { incrementReadCounter } from './read-observability';

export interface InstallationToken {
	token: string;
	expires_at: string;
}

const USER_AGENT = 'opengpt-github-mcp-worker';
const GITHUB_FETCH_TIMEOUT_MS = 30_000;

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
const cachedGetResponses = new Map<
	string,
	{
		expiresAt: number;
		status: number;
		headers: Array<[string, string]>;
		bodyText: string;
	}
>();
const cachedGetErrors = new Map<string, { expiresAt: number; message: string }>();
const inflightGetRequests = new Map<
	string,
	Promise<{
		expiresAt: number;
		status: number;
		headers: Array<[string, string]>;
		bodyText: string;
	}>
>();

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

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function buildReadCacheKey(method: string, path: string, options: GitHubRequestOptions): string {
	return stableStringify({
		method: method.toUpperCase(),
		path,
		params: options.params ?? {},
		headers: options.headers ?? {},
	});
}

function readCacheTtlMs(path: string): number {
	if (path.includes('/git/trees/')) return 20_000;
	if (path.includes('/contents/')) return 20_000;
	if (path.includes('/actions/runs')) return 12_000;
	if (path.includes('/pulls/') && path.endsWith('/files')) return 12_000;
	return 30_000;
}

function errorCacheTtlMs(path: string): number {
	if (path.includes('/contents/')) return 5_000;
	return 3_000;
}

function isBinaryGithubResponsePath(path: string): boolean {
	return path.endsWith('/zip') || path.endsWith('/logs');
}

function cloneCachedResponse(entry: {
	status: number;
	headers: Array<[string, string]>;
	bodyText: string;
}): Response {
	return new Response(entry.bodyText, {
		status: entry.status,
		headers: new Headers(entry.headers),
	});
}

async function cacheApiRequest(cacheKey: string): Promise<Request> {
	return new Request(`https://github-cache.internal/${await sha256Hex(cacheKey)}`);
}

function getDefaultCache(): Cache | null {
	const maybeCaches = (globalThis as typeof globalThis & { caches?: CacheStorage }).caches;
	return maybeCaches?.default ?? null;
}

async function getCacheApiResponse(cacheKey: string): Promise<Response | null> {
	const cache = getDefaultCache();
	if (!cache) {
		return null;
	}
	return (await cache.match(await cacheApiRequest(cacheKey))) ?? null;
}

async function putCacheApiResponse(
	cacheKey: string,
	entry: { status: number; headers: Array<[string, string]>; bodyText: string },
	ttlMs: number,
): Promise<void> {
	const cache = getDefaultCache();
	if (!cache) {
		return;
	}
	const headers = new Headers(entry.headers);
	headers.set('cache-control', `max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`);
	await cache.put(
		await cacheApiRequest(cacheKey),
		new Response(entry.bodyText, {
			status: entry.status,
			headers,
		}),
	);
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
	const normalizedMethod = method.toUpperCase();
	const binaryResponse = isBinaryGithubResponsePath(path);
	const cacheableGet = normalizedMethod === 'GET' && options.body === undefined && !binaryResponse;
	const cacheKey = cacheableGet ? buildReadCacheKey(normalizedMethod, path, options) : null;
	const now = Date.now();
	if (cacheKey) {
		const cachedError = cachedGetErrors.get(cacheKey);
		if (cachedError && cachedError.expiresAt > now) {
			incrementReadCounter('github_negative_cache_hit');
			throw new Error(cachedError.message);
		}
		const cachedResponse = cachedGetResponses.get(cacheKey);
		if (cachedResponse && cachedResponse.expiresAt > now) {
			incrementReadCounter('github_cache_hit');
			return cloneCachedResponse(cachedResponse);
		}
		const cacheApiResponse = await getCacheApiResponse(cacheKey);
		if (cacheApiResponse) {
			const bodyText = await cacheApiResponse.text();
			const entry = {
				expiresAt: Date.now() + readCacheTtlMs(path),
				status: cacheApiResponse.status,
				headers: Array.from(cacheApiResponse.headers.entries()),
				bodyText,
			};
			cachedGetResponses.set(cacheKey, entry);
			incrementReadCounter('github_cache_hit');
			return cloneCachedResponse(entry);
		}
		incrementReadCounter('github_cache_miss');
		const inflight = inflightGetRequests.get(cacheKey);
		if (inflight) {
			return cloneCachedResponse(await inflight);
		}
	}

	if (binaryResponse) {
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
			incrementReadCounter('github_remote_call');
			if (response.ok) {
				return response;
			}
			if ((response.status === 401 || response.status === 403) && attempt === 0) {
				clearInstallationTokenCache(env);
				continue;
			}
			const message = await response.text();
			throw new Error(`github request failed: ${method} ${path} -> ${response.status} ${message}`.trim());
		}
		throw new Error(`github request failed: ${method} ${path} -> exhausted retries`);
	}

	const fetchPromise = (async () => {
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
			incrementReadCounter('github_remote_call');
			if (response.ok) {
				const bodyText = await response.text();
				const entry = {
					expiresAt: Date.now() + readCacheTtlMs(path),
					status: response.status,
					headers: Array.from(response.headers.entries()),
					bodyText,
				};
				if (cacheKey) {
					cachedGetResponses.set(cacheKey, entry);
					await putCacheApiResponse(cacheKey, entry, readCacheTtlMs(path));
				}
				return entry;
			}
			if ((response.status === 401 || response.status === 403) && attempt === 0) {
				clearInstallationTokenCache(env);
				continue;
			}
			const message = await response.text();
			const fullMessage = `github request failed: ${method} ${path} -> ${response.status} ${message}`.trim();
			if (cacheKey && (response.status === 403 || response.status === 404)) {
				cachedGetErrors.set(cacheKey, {
					expiresAt: Date.now() + errorCacheTtlMs(path),
					message: fullMessage,
				});
			}
			throw new Error(fullMessage);
		}
		throw new Error(`github request failed: ${method} ${path} -> exhausted retries`);
	})();

	if (cacheKey) {
		inflightGetRequests.set(cacheKey, fetchPromise);
	}
	try {
		return cloneCachedResponse(await fetchPromise);
	} catch (error) {
		if (cacheKey) {
			cachedGetErrors.set(cacheKey, {
				expiresAt: Date.now() + errorCacheTtlMs(path),
				message: error instanceof Error ? error.message : String(error),
			});
		}
		throw error;
	} finally {
		if (cacheKey) {
			inflightGetRequests.delete(cacheKey);
		}
	}
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

export async function githubPatch(env: AppEnv, path: string, body?: unknown): Promise<unknown> {
	return githubRequest(env, 'PATCH', path, { body });
}

export async function githubDelete(env: AppEnv, path: string): Promise<unknown> {
	return githubRequest(env, 'DELETE', path);
}
