import { AppEnv, UploadSessionRecord } from './contracts';
import { inspectFileAtBranch } from './github-file-commit';
import { nowIso } from './utils';
import { MAX_STREAMED_UPLOAD_BYTES, RECOMMENDED_UPLOAD_CHUNK_BYTES, UPLOAD_SESSION_TTL_MS } from './upload-session';

async function uploadSessionFetch(
	env: AppEnv,
	uploadId: string,
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const id = env.FILE_UPLOADS.idFromName(uploadId);
	const stub = env.FILE_UPLOADS.get(id);
	const response = await stub.fetch(`https://upload.internal${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = (await response.json()) as Record<string, unknown>;
	if (!response.ok || payload.ok === false) {
		throw new Error(String(payload.error ?? `upload session request failed for ${path}`));
	}
	return payload;
}

export async function createUploadSession(
	env: AppEnv,
	input: {
		owner: string;
		repo: string;
		branch: string;
		path: string;
		message: string;
		expected_blob_sha?: string | null;
		content_kind?: 'text' | 'binary' | null;
		mime_type?: string | null;
		total_bytes?: number | null;
	},
): Promise<Record<string, unknown>> {
	if (input.total_bytes !== undefined && input.total_bytes !== null && input.total_bytes > MAX_STREAMED_UPLOAD_BYTES) {
		throw new Error(`upload exceeds max bytes for ${input.path}`);
	}
	const uploadId = crypto.randomUUID();
	const inspection = await inspectFileAtBranch(env, input.owner, input.repo, input.branch, input.path);
	if (
		input.expected_blob_sha !== undefined &&
		input.expected_blob_sha !== null &&
		input.expected_blob_sha !== inspection.blob_sha
	) {
		throw new Error(`expected blob sha mismatch for ${input.path}`);
	}
	const createdAt = nowIso();
	const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
	const session: UploadSessionRecord = {
		upload_id: uploadId,
		owner: input.owner,
		repo: input.repo,
		branch: input.branch,
		path: input.path,
		message: input.message,
		expected_blob_sha: input.expected_blob_sha ?? null,
		content_kind: input.content_kind ?? null,
		mime_type: input.mime_type ?? null,
		total_bytes: input.total_bytes ?? null,
		recommended_chunk_bytes: RECOMMENDED_UPLOAD_CHUNK_BYTES,
		base_ref_sha: inspection.ref_sha,
		existing_blob_sha: inspection.blob_sha,
		state: 'open',
		next_chunk_index: 0,
		next_byte_offset: 0,
		received_bytes: 0,
		chunk_count: 0,
		chunk_byte_lengths: [],
		commit_attempts: 0,
		created_at: createdAt,
		expires_at: expiresAt,
		committed_at: null,
		last_error: null,
		last_failed_at: null,
	};
	return uploadSessionFetch(env, uploadId, '/start', { session });
}

export async function appendUploadChunk(
	env: AppEnv,
	uploadId: string,
	input: { chunk_b64: string; chunk_index: number; byte_offset: number },
): Promise<Record<string, unknown>> {
	return uploadSessionFetch(env, uploadId, '/append', input);
}

export async function commitUploadSession(env: AppEnv, uploadId: string): Promise<Record<string, unknown>> {
	return uploadSessionFetch(env, uploadId, '/commit');
}

export async function abortUploadSession(env: AppEnv, uploadId: string): Promise<Record<string, unknown>> {
	return uploadSessionFetch(env, uploadId, '/abort');
}

