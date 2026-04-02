import { AppEnv } from './contracts';
import { sha256Hex } from './utils';

export interface PreviewTokenPayload {
	type: 'preview';
	preview_id: string;
	repo: string;
	ref: string;
	status: string;
	urls: Record<string, string>;
	expires_at: string | null;
	created_at: string;
	healthcheck_path?: string | null;
	workflow?: {
		owner: string;
		repo: string;
		run_id: number;
		workflow_id: string;
	};
}

export interface BrowserSessionTokenPayload {
	type: 'browser_session';
	session_id: string;
	target: {
		type: 'preview' | 'url' | 'static_file';
		value: string;
	};
	resolved_url: string;
	viewport: 'desktop' | 'tablet' | 'mobile';
	locale: string;
	color_scheme: 'light' | 'dark';
	file_name?: string | null;
	file_text?: string | null;
	created_at: string;
	expires_at?: string | null;
}

export interface BrowserResultTokenPayload {
	type: 'browser_result';
	session_id: string;
	run_id: number | null;
	run_html_url: string | null;
	summary: Record<string, unknown>;
	diagnostics: Record<string, unknown>;
	created_at: string;
	expires_at?: string | null;
	workflow?: {
		owner: string;
		repo: string;
		workflow_id: string;
	};
}

export interface ConfirmTokenPayload {
	type: 'confirm';
	action: 'db_reset';
	repo: string;
	ref: string;
	issued_at: string;
	expires_at: string;
}

export type EncodedTokenPayload =
	| PreviewTokenPayload
	| BrowserSessionTokenPayload
	| BrowserResultTokenPayload
	| ConfirmTokenPayload;

const TOKEN_VERSION = 'v1';

function encodeBase64Url(value: string): string {
	return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	return atob(`${normalized}${padding}`);
}

async function signPayload(env: AppEnv, payloadSegment: string): Promise<string> {
	const secret = env.WEBHOOK_SECRET?.trim() || env.QUEUE_API_TOKEN?.trim();
	if (!secret) {
		throw new Error('state token secret is not configured');
	}
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${TOKEN_VERSION}.${payloadSegment}`));
	let binary = '';
	for (const byte of new Uint8Array(signature)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function assertTokenNotExpired(payload: EncodedTokenPayload): void {
	if (!('expires_at' in payload) || typeof payload.expires_at !== 'string' || !payload.expires_at.trim()) {
		return;
	}
	const expiresAt = Date.parse(payload.expires_at);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
		throw new Error('token expired');
	}
}

export async function encodeToken<T extends EncodedTokenPayload>(env: AppEnv, payload: T): Promise<string> {
	const payloadSegment = encodeBase64Url(JSON.stringify(payload));
	const signature = await signPayload(env, payloadSegment);
	return `${TOKEN_VERSION}.${payloadSegment}.${signature}`;
}

export async function decodeToken<T extends EncodedTokenPayload>(
	env: AppEnv,
	token: string,
	expectedType: T['type'],
): Promise<T> {
	const segments = token.split('.');
	if (segments.length !== 3 || segments[0] !== TOKEN_VERSION) {
		throw new Error('invalid token format');
	}
	const [, payloadSegment, signatureSegment] = segments;
	const expectedSignature = await signPayload(env, payloadSegment);
	if (signatureSegment !== expectedSignature) {
		throw new Error('invalid token signature');
	}
	const parsed = JSON.parse(decodeBase64Url(payloadSegment)) as EncodedTokenPayload;
	if (!parsed || parsed.type !== expectedType) {
		throw new Error(`invalid token type: expected ${expectedType}`);
	}
	assertTokenNotExpired(parsed);
	return parsed as T;
}

export async function buildConfirmToken(
	env: AppEnv,
	input: {
		action: ConfirmTokenPayload['action'];
		repo: string;
		ref: string;
		ttl_minutes?: number;
	},
): Promise<{ token: string; payload: ConfirmTokenPayload }> {
	const payload: ConfirmTokenPayload = {
		type: 'confirm',
		action: input.action,
		repo: input.repo,
		ref: input.ref,
		issued_at: new Date().toISOString(),
		expires_at: new Date(Date.now() + 60_000 * (input.ttl_minutes ?? 10)).toISOString(),
	};
	return {
		token: await encodeToken(env, payload),
		payload,
	};
}

export async function validateConfirmToken(
	env: AppEnv,
	input: {
		token: string;
		action: ConfirmTokenPayload['action'];
		repo: string;
		ref: string;
	},
): Promise<ConfirmTokenPayload> {
	const payload = await decodeToken<ConfirmTokenPayload>(env, input.token, 'confirm');
	if (payload.action !== input.action || payload.repo !== input.repo || payload.ref !== input.ref) {
		throw new Error('confirm token does not match the requested action');
	}
	return payload;
}

export async function buildStablePreviewId(repo: string, ref: string): Promise<string> {
	return `pv_${(await sha256Hex(`${repo}:${ref}`)).slice(0, 12)}`;
}

export async function buildStableBrowserSessionId(resolvedUrl: string): Promise<string> {
	return `br_${(await sha256Hex(resolvedUrl)).slice(0, 12)}`;
}

