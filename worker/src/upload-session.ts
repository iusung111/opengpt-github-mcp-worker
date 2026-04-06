import { DurableObject } from 'cloudflare:workers';
import { commitUploadedFile } from './github-file-commit';
import { AppEnv, UploadSessionRecord } from './types';
import { nowIso } from './utils';

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

function normalizeSession(session: UploadSessionRecord): UploadSessionRecord {
	return {
		...session,
		duplicate_chunk_count: session.duplicate_chunk_count ?? 0,
		append_retry_count: session.append_retry_count ?? 0,
		commit_attempts: session.commit_attempts ?? 0,
		last_chunk_index: session.last_chunk_index ?? null,
		last_byte_offset: session.last_byte_offset ?? null,
		last_error: session.last_error ?? null,
		last_failed_at: session.last_failed_at ?? null,
		last_commit_error_code: session.last_commit_error_code ?? null,
		last_error_fingerprint: session.last_error_fingerprint ?? null,
	};
}

function classifyUploadError(message: string): { code: string; fingerprint: string } {
	if (message.includes('expired')) return { code: 'upload_session_expired', fingerprint: 'upload_session_expired' };
	if (message.includes('invalid upload chunk base64')) return { code: 'invalid_chunk_base64', fingerprint: 'invalid_chunk_base64' };
	if (message.includes('unexpected upload chunk index')) return { code: 'unexpected_chunk_index', fingerprint: 'upload_append_out_of_order' };
	if (message.includes('unexpected upload byte offset')) return { code: 'unexpected_byte_offset', fingerprint: 'upload_append_offset_mismatch' };
	if (message.includes('upload chunk too large')) return { code: 'chunk_too_large', fingerprint: 'upload_chunk_too_large' };
	if (message.includes('upload exceeds declared total bytes')) return { code: 'declared_total_bytes_exceeded', fingerprint: 'upload_total_bytes_exceeded' };
	if (message.includes('upload exceeds max bytes')) return { code: 'streamed_upload_bytes_exceeded', fingerprint: 'upload_max_bytes_exceeded' };
	if (message.includes('upload chunk missing')) return { code: 'upload_chunk_missing', fingerprint: 'upload_chunk_missing' };
	if (message.includes('upload chunk count mismatch')) return { code: 'upload_chunk_count_mismatch', fingerprint: 'upload_chunk_count_mismatch' };
	if (message.includes('upload byte count mismatch')) return { code: 'upload_byte_count_mismatch', fingerprint: 'upload_byte_count_mismatch' };
	if (message.includes('upload is incomplete')) return { code: 'upload_incomplete', fingerprint: 'upload_commit_incomplete' };
	return { code: 'upload_session_error', fingerprint: 'upload_session_error' };
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

export class UploadSessionDurableObject extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
	}

	private async getSession(): Promise<UploadSessionRecord | null> {
		const session = (await this.ctx.storage.get<UploadSessionRecord>(metadataStorageKey())) ?? null;
		return session ? normalizeSession(session) : null;
	}

	private async putSession(session: UploadSessionRecord): Promise<void> {
		await this.ctx.storage.put(metadataStorageKey(), normalizeSession(session));
	}

	private async recordFailure(
		session: UploadSessionRecord,
		error: unknown,
		overrides: Partial<UploadSessionRecord> = {},
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const classified = classifyUploadError(message);
		await this.putSession({
			...session,
			...overrides,
			last_error: message,
			last_failed_at: nowIso(),
			last_commit_error_code: overrides.last_commit_error_code ?? classified.code,
			last_error_fingerprint: overrides.last_error_fingerprint ?? classified.fingerprint,
		});
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
			await this.recordFailure(session, new Error(`upload session expired: ${session.upload_id}`), {
					state: 'expired',
					last_commit_error_code: 'upload_session_expired',
					last_error_fingerprint: 'upload_session_expired',
				});
			throw new Error(`upload session expired: ${session.upload_id}`);
		}
		return session;
	}

	private async handleStart(request: Request): Promise<Response> {
		const payload = (await request.json()) as StartUploadPayload;
		await this.putSession(normalizeSession(payload.session));
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
		session.last_chunk_index = payload.chunk_index;
		session.last_byte_offset = payload.byte_offset;
		if (session.state !== 'open') {
			await this.recordFailure(session, new Error(`upload session is not open: ${session.state}`));
			throw new Error(`upload session is not open: ${session.state}`);
		}
		if (payload.chunk_index !== session.next_chunk_index) {
			if (payload.chunk_index < session.next_chunk_index) {
				session.duplicate_chunk_count = (session.duplicate_chunk_count ?? 0) + 1;
				session.append_retry_count = (session.append_retry_count ?? 0) + 1;
				await this.recordFailure(session, new Error(`unexpected upload chunk index: expected ${session.next_chunk_index}`), {
						last_commit_error_code: 'unexpected_chunk_index',
						last_error_fingerprint: 'upload_append_duplicate_chunk',
					});
				} else {
					await this.recordFailure(session, new Error(`unexpected upload chunk index: expected ${session.next_chunk_index}`));
				}
				throw new Error(`unexpected upload chunk index: expected ${session.next_chunk_index}`);
		}
		if (payload.byte_offset !== session.next_byte_offset) {
			if (payload.byte_offset < session.next_byte_offset) {
				session.append_retry_count = (session.append_retry_count ?? 0) + 1;
				await this.recordFailure(session, new Error(`unexpected upload byte offset: expected ${session.next_byte_offset}`), {
						last_commit_error_code: 'unexpected_byte_offset',
						last_error_fingerprint: 'upload_append_duplicate_offset',
					});
				} else {
					await this.recordFailure(session, new Error(`unexpected upload byte offset: expected ${session.next_byte_offset}`));
				}
				throw new Error(`unexpected upload byte offset: expected ${session.next_byte_offset}`);
		}
		const bytes = decodeBase64Bytes(payload.chunk_b64);
		if (bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
			await this.recordFailure(session, new Error(`upload chunk too large: ${bytes.byteLength} bytes`));
			throw new Error(`upload chunk too large: ${bytes.byteLength} bytes`);
		}
		if (session.total_bytes !== null && session.total_bytes !== undefined && payload.byte_offset + bytes.byteLength > session.total_bytes) {
			await this.recordFailure(session, new Error(`upload exceeds declared total bytes for ${session.upload_id}`));
			throw new Error(`upload exceeds declared total bytes for ${session.upload_id}`);
		}
		if (session.received_bytes + bytes.byteLength > MAX_STREAMED_UPLOAD_BYTES) {
			await this.recordFailure(session, new Error(`upload exceeds max bytes for ${session.upload_id}`));
			throw new Error(`upload exceeds max bytes for ${session.upload_id}`);
		}

		await this.ctx.storage.put(chunkStorageKey(payload.chunk_index), bytes);
		session.chunk_count += 1;
		session.next_chunk_index += 1;
		session.received_bytes += bytes.byteLength;
		session.next_byte_offset += bytes.byteLength;
		session.last_error = null;
		session.last_failed_at = null;
		session.last_commit_error_code = null;
		session.last_error_fingerprint = null;
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
			await this.recordFailure(session, new Error(`upload session already committed: ${session.upload_id}`), {
					last_commit_error_code: 'already_committed',
					last_error_fingerprint: 'upload_commit_already_committed',
				});
			throw new Error(`upload session already committed: ${session.upload_id}`);
		}
		if (session.state === 'aborted') {
			await this.recordFailure(session, new Error(`upload session already aborted: ${session.upload_id}`), {
					last_commit_error_code: 'already_aborted',
					last_error_fingerprint: 'upload_commit_already_aborted',
				});
			throw new Error(`upload session already aborted: ${session.upload_id}`);
		}
		if (session.state === 'committing') {
			await this.recordFailure(session, new Error(`upload session already committing: ${session.upload_id}`), {
					last_commit_error_code: 'already_committing',
					last_error_fingerprint: 'upload_commit_already_committing',
				});
			throw new Error(`upload session already committing: ${session.upload_id}`);
		}
		if (session.total_bytes !== null && session.total_bytes !== undefined && session.received_bytes !== session.total_bytes) {
			await this.recordFailure(session, new Error(`upload is incomplete: expected ${session.total_bytes} bytes, received ${session.received_bytes}`));
			throw new Error(`upload is incomplete: expected ${session.total_bytes} bytes, received ${session.received_bytes}`);
		}

		session.state = 'committing';
		session.commit_attempts = (session.commit_attempts ?? 0) + 1;
		await this.putSession(session);
		const chunks: Uint8Array[] = [];
		for (let index = 0; index < session.chunk_count; index += 1) {
			const chunk = await this.ctx.storage.get<Uint8Array>(chunkStorageKey(index));
			if (!chunk) {
				await this.recordFailure(session, new Error(`upload chunk missing for ${session.upload_id}: ${index}`));
				throw new Error(`upload chunk missing for ${session.upload_id}: ${index}`);
			}
			chunks.push(chunk);
		}
		if (chunks.length !== session.chunk_count) {
			await this.recordFailure(session, new Error(`upload chunk count mismatch for ${session.upload_id}`));
			throw new Error(`upload chunk count mismatch for ${session.upload_id}`);
		}
		const bytes = concatBytes(chunks);
		if (bytes.byteLength !== session.received_bytes) {
			await this.recordFailure(session, new Error(`upload byte count mismatch for ${session.upload_id}`));
			throw new Error(`upload byte count mismatch for ${session.upload_id}`);
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
			session.last_commit_error_code = null;
			session.last_error_fingerprint = null;
			await this.putSession(session);
			await this.deleteChunkData();
			return Response.json({
				ok: true,
				upload_id: session.upload_id,
				session,
				result,
			});
		} catch (error) {
			session.state = 'open';
			await this.recordFailure(session, error);
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
