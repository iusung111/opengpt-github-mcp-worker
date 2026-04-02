import { JobRecord } from './contracts';
import { canonicalizeRepoKey, canonicalizeWorkspacePath } from './repo-aliases';

const encoder = new TextEncoder();

export function jobStorageKey(jobId: string): string {
	return `job:${jobId}`;
}

export function auditStorageKey(id: string): string {
	return `audit:${id}`;
}

export function deliveryStorageKey(deliveryId: string): string {
	return `delivery:${deliveryId}`;
}

export function workspaceStorageKey(repoKey: string): string {
	return `workspace:${canonicalizeRepoKey(repoKey).toLowerCase()}`;
}

export function activeWorkspaceStorageKey(): string {
	return 'workspace:active_repo_key';
}

function branchMatchesJobHint(workBranch: string, job: JobRecord): boolean {
	if (!workBranch.startsWith('agent/')) {
		return false;
	}
	const encodedJobId = `agent/${job.job_id}`;
	return workBranch === encodedJobId || workBranch.startsWith(`${encodedJobId}-`);
}

export function parseJobIdFromPrBody(body?: string): string | null {
	if (!body) {
		return null;
	}
	const metadataMatch = body.match(/job_id:\s*([A-Za-z0-9._-]+)/i);
	return metadataMatch?.[1] ?? null;
}

export function branchMatchScore(workBranch: string, job: JobRecord): number {
	if (!workBranch || job.work_branch === workBranch) {
		return 4;
	}
	if (job.work_branch && workBranch.startsWith(`${job.work_branch}-`)) {
		return 3;
	}
	if (branchMatchesJobHint(workBranch, job)) {
		return 2;
	}
	return 0;
}

export function normalizeLookup(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/\/+$/g, '')
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
}

export function normalizeWorkspacePath(path: string): string {
	const trimmed = canonicalizeWorkspacePath(String(path ?? '').trim());
	if (!trimmed) {
		return '';
	}
	const withForwardSlashes = trimmed.replace(/\\/g, '/');
	if (withForwardSlashes.startsWith('//')) {
		const collapsed = `//${withForwardSlashes.slice(2).replace(/\/+/g, '/')}`;
		return collapsed.length > 2 ? collapsed.replace(/\/+$/, '') : collapsed;
	}
	const collapsed = withForwardSlashes.replace(/\/+/g, '/');
	if (/^[A-Za-z]:\/?$/.test(collapsed)) {
		return collapsed.endsWith('/') ? collapsed : `${collapsed}/`;
	}
	return collapsed !== '/' ? collapsed.replace(/\/+$/, '') : collapsed;
}

function isAbsoluteWorkspacePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

function workspacePathHasUnsafeSegments(path: string): boolean {
	const normalized = normalizeWorkspacePath(path);
	let relative = normalized;
	if (normalized.startsWith('//')) {
		relative = normalized.slice(2);
	} else if (/^[A-Za-z]:\//.test(normalized)) {
		relative = normalized.slice(3);
	} else if (normalized.startsWith('/')) {
		relative = normalized.slice(1);
	}
	return relative
		.split('/')
		.filter(Boolean)
		.some((segment) => segment === '.' || segment === '..');
}

export function ensureSafeWorkspacePath(path: string): string {
	const normalized = normalizeWorkspacePath(path);
	if (!normalized || !isAbsoluteWorkspacePath(normalized) || workspacePathHasUnsafeSegments(normalized)) {
		throw new Error(
			`invalid workspace path: ${path}. Workspace paths must be absolute local filesystem paths like D:/VScode/projects/opengpt or /home/user/workspace/projects/opengpt.`,
		);
	}
	return normalized;
}

async function sha256HmacHex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function verifyWebhookSignature(secret: string, payload: string, signatureHeader: string | null): Promise<boolean> {
	if (!secret) {
		return true;
	}
	if (!signatureHeader?.startsWith('sha256=')) {
		return false;
	}
	const expected = `sha256=${await sha256HmacHex(secret, payload)}`;
	return expected === signatureHeader;
}

