export const encoder = new TextEncoder();
export const QUEUE_FETCH_TIMEOUT_MS = 8_000;

export function nowIso(): string {
	return new Date().toISOString();
}

export function diagnosticLog(event: string, payload: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: nowIso(), event, ...payload }));
}

export function normalizeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function buildErrorFingerprint(parts: Array<unknown>): string {
	return parts
		.map((value) => String(value ?? ''))
		.map((value) => value.trim().toLowerCase().replace(/\s+/g, ' '))
		.filter(Boolean)
		.join('|')
		.slice(0, 240);
}

export function recordRuntimeEvent(event: string, payload: Record<string, unknown>): void {
	diagnosticLog(`runtime.${event}`, payload);
}

function getBooleanEnvFlag(env: unknown, key: string, fallback: boolean): boolean {
	if (!hasRecord(env)) return fallback;
	const raw = env[key];
	if (typeof raw === 'boolean') return raw;
	if (typeof raw === 'string') {
		const normalized = raw.trim().toLowerCase();
		if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
		if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
	}
	return fallback;
}

export function isStrictMirrorVerifyEnabled(env: unknown): boolean {
	return getBooleanEnvFlag(env, 'STRICT_MIRROR_VERIFY', false);
}

export function isStrictDocImplSyncEnabled(env: unknown): boolean {
	return getBooleanEnvFlag(env, 'STRICT_DOC_IMPL_SYNC', false);
}

export function isStrictFingerprintBlockEnabled(env: unknown): boolean {
	return getBooleanEnvFlag(env, 'STRICT_FINGERPRINT_BLOCK', false);
}

export function isSelfImproveSafeModeEnabled(env: unknown): boolean {
	return getBooleanEnvFlag(env, 'SELF_IMPROVE_SAFE_MODE', true);
}

export function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

export function errorStatus(error: unknown): number {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('github timeout:')) {
		return 504;
	}
	if (message.includes('github auth failed:')) {
		return 401;
	}
	if (message.includes('github permission failed:')) {
		return 403;
	}
	if (
		message.includes('github upstream failed:') ||
		message.includes('github request failed:') ||
		message.includes('failed to create installation token:') ||
		message.includes('github network failed:')
	) {
		return 502;
	}
	if (
		message.includes('unsafe ') ||
		message.includes('not allowlisted') ||
		message.includes('invalid ') ||
		message.includes('must start with') ||
		message.includes('forbidden') ||
		message.includes('already exists')
	) {
		return 400;
	}
	return 500;
}

export function errorCodeFor(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('github timeout:')) return 'github_timeout';
	if (message.includes('github auth failed:')) return 'github_auth_failed';
	if (message.includes('github permission failed:')) return 'github_permission_failed';
	if (message.includes('github upstream failed:')) return 'github_upstream_failed';
	if (message.includes('github network failed:')) return 'github_network_failed';
	if (message.includes('failed to create installation token:')) return 'github_installation_token_failed';
	if (message.includes('Merge conflict')) return 'pr_merge_conflict';
	if (message.includes('Pull Request is not mergeable')) return 'pr_not_mergeable';
	if (message.includes('repository not allowlisted')) return 'repo_not_allowlisted';
	if (message.includes('workflow not allowlisted')) return 'workflow_not_allowlisted';
	if (message.includes('workflow not found')) return 'workflow_not_found';
	if (message.includes('workflow does not support workflow_dispatch')) return 'workflow_missing_dispatch_trigger';
	if (message.includes('invalid repo identity')) return 'invalid_repo_identity';
	if (message.includes('invalid repo path')) return 'invalid_repo_path';
	if (message.includes('invalid workspace path')) return 'invalid_workspace_path';
	if (message.includes('unsafe path')) return 'unsafe_path';
	if (message.includes('direct write to') && message.includes('forbidden')) return 'default_branch_forbidden';
	if (message.includes('expected blob sha mismatch')) return 'expected_blob_sha_mismatch';
	if (message.includes('upload session expired')) return 'upload_session_expired';
	if (message.includes('upload session not found')) return 'upload_session_not_found';
	if (message.includes('upload session already committed')) return 'upload_session_already_committed';
	if (message.includes('upload session already aborted')) return 'upload_session_already_aborted';
	if (message.includes('upload session already committing')) return 'upload_session_already_committing';
	if (message.includes('unexpected upload chunk index')) return 'upload_chunk_index_mismatch';
	if (message.includes('unexpected upload byte offset')) return 'upload_chunk_offset_mismatch';
	if (message.includes('duplicate upload chunk content mismatch')) return 'upload_chunk_duplicate_conflict';
	if (message.includes('invalid upload chunk base64')) return 'upload_chunk_invalid_base64';
	if (message.includes('upload chunk too large')) return 'upload_chunk_too_large';
	if (message.includes('upload exceeds declared total bytes')) return 'upload_total_bytes_exceeded';
	if (message.includes('upload exceeds max bytes')) return 'upload_max_bytes_exceeded';
	if (message.includes('upload is incomplete')) return 'upload_incomplete';
	if (message.includes('upload branch head changed')) return 'upload_branch_head_changed';
	if (message.includes('content_b64 too large')) return 'repo_update_file_payload_too_large';
	return fallback;
}

export function parseIsoMs(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isOlderThan(iso: string | null | undefined, thresholdMs: number): boolean {
	const ms = parseIsoMs(iso);
	if (ms === null) return false;
	return Date.now() - ms > thresholdMs;
}

export function hasRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
