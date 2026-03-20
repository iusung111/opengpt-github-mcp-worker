const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const USER_AGENT = 'opengpt-github-mcp-worker';
const CLOUDFLARE_FETCH_TIMEOUT_MS = 10_000;

type AppEnv = Env & {
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
};

interface CloudflareRequestOptions {
	params?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
}

interface CloudflareEnvelope<T> {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: Array<{ code?: number; message?: string }>;
	result?: T;
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort('cloudflare_timeout'), CLOUDFLARE_FETCH_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

export function cloudflareAuthConfigured(env: AppEnv): boolean {
	return Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
}

export async function cloudflareRequest<T>(
	env: AppEnv,
	method: string,
	path: string,
	options: CloudflareRequestOptions = {},
): Promise<T> {
	if (!cloudflareAuthConfigured(env)) {
		throw new Error('Cloudflare credentials are not fully configured');
	}
	const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
	const url = new URL(normalizedPath, `${CLOUDFLARE_API_BASE}/`);
	for (const [key, value] of Object.entries(options.params ?? {})) {
		if (value === undefined) {
			continue;
		}
		url.searchParams.set(key, String(value));
	}
	const response = await fetchWithTimeout(url.toString(), {
		method,
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			'User-Agent': USER_AGENT,
			...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...options.headers,
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	const contentType = response.headers.get('content-type') ?? '';
	const json = contentType.includes('application/json') && text
		? (JSON.parse(text) as CloudflareEnvelope<T>)
		: null;
	if (!response.ok) {
		const apiMessage = json?.errors?.map((item) => item.message).filter(Boolean).join('; ');
		throw new Error(`cloudflare request failed: ${response.status} ${apiMessage || text}`.trim());
	}
	if (json && json.success === false) {
		const apiMessage = json.errors?.map((item) => item.message).filter(Boolean).join('; ');
		throw new Error(`cloudflare request failed: ${apiMessage || 'unknown error'}`);
	}
	if (json) {
		return (json.result ?? null) as T;
	}
	return text as T;
}

export async function cloudflareGet<T>(
	env: AppEnv,
	path: string,
	options: Omit<CloudflareRequestOptions, 'body'> = {},
): Promise<T> {
	return cloudflareRequest<T>(env, 'GET', path, options);
}

export async function cloudflarePost<T>(
	env: AppEnv,
	path: string,
	options: CloudflareRequestOptions = {},
): Promise<T> {
	return cloudflareRequest<T>(env, 'POST', path, options);
}

export async function cloudflarePut<T>(
	env: AppEnv,
	path: string,
	options: CloudflareRequestOptions = {},
): Promise<T> {
	return cloudflareRequest<T>(env, 'PUT', path, options);
}
