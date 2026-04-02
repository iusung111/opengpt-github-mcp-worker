import { incrementReadCounter } from '../read-observability';
import type { GitHubEnv, GitHubRequestOptions } from './types';
import {
	buildReadCacheKey,
	cacheGithubError,
	clearInflightGithubRequest,
	cloneCachedResponse,
	errorCacheTtlMs,
	getCachedGithubError,
	getCachedGithubResponse,
	getCacheApiResponse,
	getInflightGithubRequest,
	isBinaryGithubResponsePath,
	markGithubCacheMiss,
	putCacheApiResponse,
	readCacheTtlMs,
	rememberCachedGithubResponse,
	setInflightGithubRequest,
} from './cache';
import { clearInstallationTokenCache, fetchWithTimeout, getInstallationToken, USER_AGENT } from './auth';

function responseHasNoBody(status: number): boolean {
	return status === 101 || status === 204 || status === 205 || status === 304;
}

export async function githubRequest(env: GitHubEnv, method: string, path: string, options: GitHubRequestOptions = {}): Promise<unknown> {
	const response = await githubRequestRaw(env, method, path, options);
	if (response.status === 204) return { ok: true };
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) return response.text();
	return response.json();
}

export async function githubRequestRaw(
	env: GitHubEnv,
	method: string,
	path: string,
	options: GitHubRequestOptions = {},
): Promise<Response> {
	const normalizedMethod = method.toUpperCase();
	const binaryResponse = isBinaryGithubResponsePath(path);
	const cacheableGet = normalizedMethod === 'GET' && options.body === undefined && !binaryResponse;
	const cacheKey = cacheableGet ? buildReadCacheKey(normalizedMethod, path, options) : null;
	const now = Date.now();
	if (cacheKey) {
		const cachedError = getCachedGithubError(cacheKey, now);
		if (cachedError) throw new Error(cachedError);
		const cachedResponse = getCachedGithubResponse(cacheKey, now);
		if (cachedResponse) return cachedResponse;
		const cacheApiResponse = await getCacheApiResponse(cacheKey);
		if (cacheApiResponse) {
			const bodyText = responseHasNoBody(cacheApiResponse.status) ? null : await cacheApiResponse.text();
			return rememberCachedGithubResponse(cacheKey, {
				expiresAt: Date.now() + readCacheTtlMs(path),
				status: cacheApiResponse.status,
				headers: Array.from(cacheApiResponse.headers.entries()),
				bodyText,
			});
		}
		markGithubCacheMiss();
		const inflight = getInflightGithubRequest(cacheKey);
		if (inflight) return cloneCachedResponse(await inflight);
	}

	if (binaryResponse) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const installationToken = await getInstallationToken(env);
			const url = new URL(path, env.GITHUB_API_URL ?? 'https://api.github.com');
			for (const [key, value] of Object.entries(options.params ?? {})) {
				if (value !== undefined) url.searchParams.set(key, String(value));
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
			if (response.ok) return response;
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
				if (value !== undefined) url.searchParams.set(key, String(value));
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
				const bodyText = responseHasNoBody(response.status) ? null : await response.text();
				const entry = {
					expiresAt: Date.now() + readCacheTtlMs(path),
					status: response.status,
					headers: Array.from(response.headers.entries()),
					bodyText,
				};
				if (cacheKey) {
					rememberCachedGithubResponse(cacheKey, entry);
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
				cacheGithubError(cacheKey, Date.now() + errorCacheTtlMs(path), fullMessage);
			}
			throw new Error(fullMessage);
		}
		throw new Error(`github request failed: ${method} ${path} -> exhausted retries`);
	})();

	if (cacheKey) setInflightGithubRequest(cacheKey, fetchPromise);
	try {
		return cloneCachedResponse(await fetchPromise);
	} catch (error) {
		if (cacheKey) cacheGithubError(cacheKey, Date.now() + errorCacheTtlMs(path), error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		if (cacheKey) clearInflightGithubRequest(cacheKey);
	}
}

export async function githubGet(env: GitHubEnv, path: string, options: Omit<GitHubRequestOptions, 'body'> = {}): Promise<unknown> {
	return githubRequest(env, 'GET', path, options);
}

export async function githubPost(env: GitHubEnv, path: string, body?: unknown): Promise<unknown> {
	return githubRequest(env, 'POST', path, { body });
}

export async function githubPut(env: GitHubEnv, path: string, body?: unknown): Promise<unknown> {
	return githubRequest(env, 'PUT', path, { body });
}

export async function githubPatch(env: GitHubEnv, path: string, body?: unknown): Promise<unknown> {
	return githubRequest(env, 'PATCH', path, { body });
}

export async function githubDelete(env: GitHubEnv, path: string): Promise<unknown> {
	return githubRequest(env, 'DELETE', path);
}
