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
	created_at: string;
}

export interface BrowserResultTokenPayload {
	type: 'browser_result';
	session_id: string;
	run_id: number | null;
	run_html_url: string | null;
	summary: Record<string, unknown>;
	diagnostics: Record<string, unknown>;
	created_at: string;
	workflow?: {
		owner: string;
		repo: string;
		workflow_id: string;
	};
}

export type EncodedTokenPayload = PreviewTokenPayload | BrowserSessionTokenPayload | BrowserResultTokenPayload;

function encodeBase64Url(value: string): string {
	return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	return atob(`${normalized}${padding}`);
}

export function encodeToken<T extends EncodedTokenPayload>(payload: T): string {
	return encodeBase64Url(JSON.stringify(payload));
}

export function decodeToken<T extends EncodedTokenPayload>(token: string, expectedType: T['type']): T {
	const parsed = JSON.parse(decodeBase64Url(token)) as EncodedTokenPayload;
	if (!parsed || parsed.type !== expectedType) {
		throw new Error(`invalid token type: expected ${expectedType}`);
	}
	return parsed as T;
}

export async function buildStablePreviewId(repo: string, ref: string): Promise<string> {
	return `pv_${(await sha256Hex(`${repo}:${ref}`)).slice(0, 12)}`;
}

export async function buildStableBrowserSessionId(resolvedUrl: string): Promise<string> {
	return `br_${(await sha256Hex(resolvedUrl)).slice(0, 12)}`;
}
