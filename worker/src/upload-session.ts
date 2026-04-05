import { DurableObject } from 'cloudflare:workers';
import { commitUploadedFile } from './github-file-commit';
import { AppEnv, UploadSessionRecord } from './contracts';
import { buildErrorFingerprint, errorCodeFor, normalizeErrorMessage, nowIso, recordRuntimeEvent } from './utils';

export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;
export const RECOMMENDED_UPLOAD_CHUNK_BYTES = 96 * 1024;
export const MAX_UPLOAD_CHUNK_BYTES = 128 * 1024;
export const MAX_REPO_UPDATE_FILE_B64_BYTES = 384 * 1024;
export const MAX_STREAMED_UPLOAD_BYTES = 8 * 1024 * 1024;

interface StartUploadPayload {
	session: UploadSessionRecord;
}

interface AppendUploadPayload {
	chunk_b64: string;
	chunk_index: number;
	byte_offset: number;
}

function chunkStorageKey(index: number): string {
	return `chunk:${index}`;
}

function metadataStorageKey(): string {
	return 'session';
}

function decodeBase64Bytes(value: string): Uint8Array {
	try {
		const binary = atob(value.replace(/\n/g, ''));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		throw new Error('invalid upload chunk base64');
	}
}

function encodeBase64Bytes(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

export class UploadSessionDurableObject extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
	}

	private async getSession(): Promise<UploadSessionRecord | null> {
		return (await this.ctx.storage.get<UploadSessionRecord>(metadataStorageKey())) ?? null;
	}

	private async putSession(session: UploadSessionRecord): Promise<void> {
		await this.ctx.storage.put(metadataStorageKey(), session);
	}

	private async deleteAllSessionState(): Promise<void> {
		const session = await this.getSession();
		const keys = [
			metadataStorageKey(),
			...Array.from({ length: session?.chunk_count ?? 0 }, (_, index) => chunkStorageKey(index)),
		];
		if (keys.length > 0) {
			await this.ctx.storage.delete(keys);
		}
	}

	private async expireIfNeeded(session: UploadSessionRecord): Promise<UploadSessionRecord> {
		if (session.state === 'open' && Date.parse(session.expires_at) <= Date.now()) {
			session.state = 'expired';
			await this.putSession(session);
			throw new Error(`upload session expired: ${session.upload_id}`);
		}
		return session;
	}

	private async recordSessionError(
		session: UploadSessionRecord,
		error: unknown,
		featureArea: 'upload_append' | 'upload_commit' | 'upload_abort',
		extra: Record<string, unknown> = {},
	): Promise<string> {
		const message = normalizeErrorMessage(error);
		const code = errorCodeFor(error, 'upload_session_error');
		const fingerprint = buildErrorFingerprint([
			featureArea,
			code,
			session.upload_id,
			extra.chunk_index,
			extra.byte_offset,
			message,
		]);
		session.last_error = message;
		session.last_failed_at = nowIso();
		if (featureArea === 'upload_commit') {
			session.last_commit_error_fingerprint = fingerprint;
		} else {
			session.last_chunk_error_fingerprint = fingerprint;
		}
		await this.putSession(session);
		recordRuntimeEvent('upload_session_error', {
			feature_area: featureArea,
			upload_id: session.upload_id,
			repo: `${session.owner}/${session.repo}`,
			branch: session.branch,
			path: session.path,
			state: session.state,
			error_code: code,
			error_message: message,
			error_fingerprint: fingerprint,
			recoverable: featureArea !== 'upload_abort',
			...extra,
		});
		return fingerprint;
	}

	private async maybeHandleDuplicateAppend(
		session: UploadSessionRecord,
		payload: AppendUploadPayload,
		bytes: Uint8Array,
	): Promise<Response | null> {
		if (session.next_chunk_index <= 0 || payload.chunk_index !== session.next_chunk_index - 1) {
			return null;
		}
		const existingChunk = await this.ctx.storage.get<Uint8Array>(chunkStorageKey(payload.chunk_index));
		if (!existingChunk) {
			return null;
		}
		const expectedOffset = session.next_byte_offset - existingChunk.byteLength;
		if (payload.byte_offset !== expectedOffset) {
			return null;
		}
		if (!bytesEqual(existingChunk, bytes)) {
			const error = new Error(`duplicate upload chunk content mismatch: index ${payload.chunk_index}`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
				is_duplicate_chunk: true,
				duplicate_policy: 'reject_conflict',
			});
			throw error;
		}
		recordRuntimeEvent('upload_duplicate_chunk_accepted', {
			feature_area: 'upload_append',
			upload_id: session.upload_id,
			chunk_index: payload.chunk_index,
			byte_offset: payload.byte_offset,
			state: session.state,
			is_duplicate_chunk: true,
			duplicate_policy: 'accept_idempotent',
		});
		return Response.json({
			ok: true,
			upload_id: session.upload_id,
			received_bytes: session.received_bytes,
			next_chunk_index: session.next_chunk_index,
			next_byte_offset: session.next_byte_offset,
			complete: session.total_bytes !== null && session.total_bytes !== undefined ? session.received_bytes === session.total_bytes : false,
			duplicate: true,
		});
	}

	private async handleStart(request: Request): Promise<Response> {
		const payload = (await request.json()) as StartUploadPayload;
		await this.putSession(payload.session);
		recordRuntimeEvent('upload_session_started', {
			feature_area: 'upload_start',
			upload_id: payload.session.upload_id,
			repo: `${payload.session.owner}/${payload.session.repo}`,
			branch: payload.session.branch,
			path: payload.session.path,
			total_bytes: payload.session.total_bytes ?? null,
		});
		return Response.json({
			ok: true,
			upload_id: payload.session.upload_id,
			expires_at: payload.session.expires_at,
			recommended_chunk_bytes: payload.session.recommended_chunk_bytes,
			base_ref_sha: payload.session.base_ref_sha,
			existing_blob_sha: payload.session.existing_blob_sha ?? null,
		});
	}

	private async handleAppend(request: Request): Promise<Response> {
		const payload = (await request.json()) as AppendUploadPayload;
		const session = await this.expireIfNeeded(await this.requireSession());
		if (session.state !== 'open') {
			const error = new Error(`upload session is not open: ${session.state}`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
			});
			throw error;
		}
		const bytes = decodeBase64Bytes(payload.chunk_b64);
		const duplicateResponse = await this.maybeHandleDuplicateAppend(session, payload, bytes);
		if (duplicateResponse) {
			return duplicateResponse;
		}
		if (payload.chunk_index !== session.next_chunk_index) {
			const error = new Error(`unexpected upload chunk index: expected ${session.next_chunk_index}`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
				expected_chunk_index: session.next_chunk_index,
			});
			throw error;
		}
		if (payload.byte_offset !== session.next_byte_offset) {
			const error = new Error(`unexpected upload byte offset: expected ${session.next_byte_offset}`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
				expected_byte_offset: session.next_byte_offset,
			});
			throw error;
		}
		if (bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
			const error = new Error(`upload chunk too large: ${bytes.byteLength} bytes`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
				chunk_size: bytes.byteLength,
			});
			throw error;
		}
		if (session.total_bytes !== null && session.total_bytes !== undefined && payload.byte_offset + bytes.byteLength > session.total_bytes) {
			const error = new Error(`upload exceeds declared total bytes for ${session.upload_id}`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
				chunk_size: bytes.byteLength,
				total_bytes: session.total_bytes,
			});
			throw error;
		}
		if (session.received_bytes + bytes.byteLength > MAX_STREAMED_UPLOAD_BYTES) {
			const error = new Error(`upload exceeds max bytes for ${session.upload_id}`);
			await this.recordSessionError(session, error, 'upload_append', {
				chunk_index: payload.chunk_index,
				byte_offset: payload.byte_offset,
				chunk_size: bytes.byteLength,
			});
			throw error;
		}

		await this.ctx.storage.put(chunkStorageKey(payload.chunk_index), bytes);
		session.chunk_count += 1;
		session.next_chunk_index += 1;
		session.received_bytes += bytes.byteLength;
		session.next_byte_offset += bytes.byteLength;
		await this.putSession(session);
		return Response.json({
			ok: true,
			upload_id: session.upload_id,
			received_bytes: session.received_bytes,
			next_chunk_index: session.next_chunk_index,
			next_byte_offset: session.next_byte_offset,
			complete: session.total_bytes !== null && session.total_bytes !== undefined ? session.received_bytes === session.total_bytes : false,
		});
	}

	private async handleCommit(): Promise<Response> {
		const session = await this.expireIfNeeded(await this.requireSession());
		if (session.state === 'committed') {
			throw new Error(`upload session already committed: ${session.upload_id}`);
		}
		if (session.state === 'aborted') {
			throw new Error(`upload session already aborted: ${session.upload_id}`);
		}
		if (session.state === 'committing') {
			throw new Error(`upload session already committing: ${session.upload_id}`);
		}
		if (session.total_bytes !== null && session.total_bytes !== undefined && session.received_bytes !== session.total_bytes) {
			throw new Error(`upload is incomplete: expected ${session.total_bytes} bytes, received ${session.received_bytes}`);
		}

		session.commit_attempts = (session.commit_attempts ?? 0) + 1;
		session.state = 'committing';
		await this.putSession(session);
		const chunks: Uint8Array[] = [];
		for (let index = 0; index < session.chunk_count; index += 1) {
			const chunk = await this.ctx.storage.get<Uint8Array>(chunkStorageKey(index));
			if (!chunk) {
				const error = new Error(`upload chunk missing for ${session.upload_id}: ${index}`);
				session.state = 'open';
				await this.recordSessionError(session, error, 'upload_commit', {
					chunk_index: index,
					commit_attempts: session.commit_attempts,
				});
				throw error;
			}
			chunks.push(chunk);
		}
		if (chunks.length !== session.chunk_count) {
			const error = new Error(`upload chunk count mismatch for ${session.upload_id}`);
			session.state = 'open';
			await this.recordSessionError(session, error, 'upload_commit', {
				commit_attempts: session.commit_attempts,
			});
			throw error;
		}
		const bytes = concatBytes(chunks);
		if (bytes.byteLength !== session.received_bytes) {
			const error = new Error(`upload byte count mismatch for ${session.upload_id}`);
			session.state = 'open';
			await this.recordSessionError(session, error, 'upload_commit', {
				commit_attempts: session.commit_attempts,
			});
			throw error;
		}

		try {
			const result = await commitUploadedFile(this.env, {
				owner: session.owner,
				repo: session.repo,
				branch: session.branch,
				path: session.path,
				message: session.message,
				content_b64: encodeBase64Bytes(bytes),
				base_ref_sha: session.base_ref_sha,
				expected_blob_sha: session.expected_blob_sha ?? null,
			});

			session.state = 'committed';
			session.committed_at = nowIso();
			session.last_error = null;
			session.last_failed_at = null;
			await this.putSession(session);
			await this.deleteChunkData();
			recordRuntimeEvent('upload_session_committed', {
				feature_area: 'upload_commit',
				upload_id: session.upload_id,
				repo: `${session.owner}/${session.repo}`,
				branch: session.branch,
				path: session.path,
				commit_attempts: session.commit_attempts,
			});
			return Response.json({
				ok: true,
				upload_id: session.upload_id,
				session,
				result,
			});
		} catch (error) {
			session.state = 'open';
			await this.recordSessionError(session, error, 'upload_commit', {
				commit_attempts: session.commit_attempts,
			});
			throw error;
		}
	}

	private async handleAbort(): Promise<Response> {
		const session = await this.getSession();
		if (!session) {
			return Response.json({ ok: true, aborted: true, upload_id: null, already_missing: true });
		}
		session.state = 'aborted';
		await this.putSession(session);
		recordRuntimeEvent('upload_session_aborted', {
			feature_area: 'upload_abort',
			upload_id: session.upload_id,
			repo: `${session.owner}/${session.repo}`,
			branch: session.branch,
			path: session.path,
		});
		await this.deleteAllSessionState();
		return Response.json({ ok: true, aborted: true, upload_id: session.upload_id });
	}

	private async deleteChunkData(): Promise<void> {
		const session = await this.getSession();
		const keys = Array.from({ length: session?.chunk_count ?? 0 }, (_, index) => chunkStorageKey(index));
		if (keys.length > 0) {
			await this.ctx.storage.delete(keys);
		}
	}

	private async requireSession(): Promise<UploadSessionRecord> {
		const session = await this.getSession();
		if (!session) {
			throw new Error('upload session not found');
		}
		return session;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === 'POST' && url.pathname === '/start') {
				return await this.handleStart(request);
			}
			if (request.method === 'POST' && url.pathname === '/append') {
				return await this.handleAppend(request);
			}
			if (request.method === 'POST' && url.pathname === '/commit') {
				return await this.handleCommit();
			}
			if (request.method === 'POST' && url.pathname === '/abort') {
				return await this.handleAbort();
			}
			return Response.json({ ok: false, error: 'not found' }, { status: 404 });
		} catch (error) {
			return Response.json(
				{
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				},
				{ status: 400 },
			);
		}
	}
}
