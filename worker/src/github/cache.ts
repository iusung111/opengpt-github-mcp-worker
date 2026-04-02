import { incrementReadCounter } from '../read-observability';
import type { GitHubRequestOptions } from './types';

type CachedGithubResponse = {
	expiresAt: number;
	status: number;
	headers: Array<[string, string]>;
	bodyText: string | null;
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const cachedGetResponses = new Map<string, CachedGithubResponse>();
const cachedGetErrors = new Map<string, { expiresAt: number; message: string }>();
const inflightGetRequests = new Map<string, Promise<CachedGithubResponse>>();

function responseBodyForStatus(status: number, bodyText: string | null): string | null {
	return NULL_BODY_STATUSES.has(status) ? null : (bodyText ?? '');
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function buildReadCacheKey(method: string, path: string, options: GitHubRequestOptions): string {
	return stableStringify({ method: method.toUpperCase(), path, params: options.params ?? {}, headers: options.headers ?? {} });
}

export function readCacheTtlMs(path: string): number {
	if (path.includes('/git/trees/')) return 20_000;
	if (path.includes('/contents/')) return 20_000;
	if (path.includes('/actions/runs')) return 12_000;
	if (path.includes('/pulls/') && path.endsWith('/files')) return 12_000;
	return 30_000;
}

export function errorCacheTtlMs(path: string): number {
	if (path.includes('/contents/')) return 5_000;
	return 3_000;
}

export function isBinaryGithubResponsePath(path: string): boolean {
	return path.endsWith('/zip') || path.endsWith('/logs');
}

export function cloneCachedResponse(entry: { status: number; headers: Array<[string, string]>; bodyText: string | null }): Response {
	return new Response(responseBodyForStatus(entry.status, entry.bodyText), {
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

export async function getCacheApiResponse(cacheKey: string): Promise<Response | null> {
	const cache = getDefaultCache();
	if (!cache) return null;
	return (await cache.match(await cacheApiRequest(cacheKey))) ?? null;
}

export async function putCacheApiResponse(
	cacheKey: string,
	entry: { status: number; headers: Array<[string, string]>; bodyText: string | null },
	ttlMs: number,
): Promise<void> {
	if (NULL_BODY_STATUSES.has(entry.status)) return;
	const cache = getDefaultCache();
	if (!cache) return;
	const headers = new Headers(entry.headers);
	headers.set('cache-control', `max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`);
	await cache.put(await cacheApiRequest(cacheKey), new Response(responseBodyForStatus(entry.status, entry.bodyText), { status: entry.status, headers }));
}

export function getCachedGithubError(cacheKey: string, now: number): string | null {
	const cachedError = cachedGetErrors.get(cacheKey);
	if (!cachedError || cachedError.expiresAt <= now) return null;
	incrementReadCounter('github_negative_cache_hit');
	return cachedError.message;
}

export function getCachedGithubResponse(cacheKey: string, now: number): Response | null {
	const cachedResponse = cachedGetResponses.get(cacheKey);
	if (!cachedResponse || cachedResponse.expiresAt <= now) return null;
	incrementReadCounter('github_cache_hit');
	return cloneCachedResponse(cachedResponse);
}

export function rememberCachedGithubResponse(cacheKey: string, entry: CachedGithubResponse): Response {
	cachedGetResponses.set(cacheKey, entry);
	incrementReadCounter('github_cache_hit');
	return cloneCachedResponse(entry);
}

export function markGithubCacheMiss(): void {
	incrementReadCounter('github_cache_miss');
}

export function getInflightGithubRequest(cacheKey: string) {
	return inflightGetRequests.get(cacheKey);
}

export function setInflightGithubRequest(
	cacheKey: string,
	value: Promise<CachedGithubResponse>,
): void {
	inflightGetRequests.set(cacheKey, value);
}

export function clearInflightGithubRequest(cacheKey: string): void {
	inflightGetRequests.delete(cacheKey);
}

export function cacheGithubError(cacheKey: string, expiresAt: number, message: string): void {
	cachedGetErrors.set(cacheKey, { expiresAt, message });
}
