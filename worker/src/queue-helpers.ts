import { JobRecord } from './types';

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
	return `workspace:${repoKey.toLowerCase()}`;
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
		.toLowerCase()
		.replace(/[\s_]+/g, '-');
}

function isAbsoluteWorkspacePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

export function ensureSafeWorkspacePath(path: string): void {
	const normalized = String(path ?? '').trim();
	if (!normalized || !isAbsoluteWorkspacePath(normalized) || normalized.includes('..')) {
		throw new Error(`unsafe workspace path: ${path}`);
	}
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
