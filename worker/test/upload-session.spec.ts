import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UploadSessionRecord } from '../src/contracts';
import { RECOMMENDED_UPLOAD_CHUNK_BYTES } from '../src/upload-session';

function createSession(uploadId: string): UploadSessionRecord {
	return {
		upload_id: uploadId,
		owner: 'iusung111',
		repo: 'Project_OpenGPT',
		branch: 'agent/upload-session-test',
		path: 'README.md',
		message: 'Upload README via stream',
		expected_blob_sha: 'readme-blob-sha',
		content_kind: 'text',
		mime_type: 'text/markdown',
		total_bytes: 20,
		recommended_chunk_bytes: RECOMMENDED_UPLOAD_CHUNK_BYTES,
		base_ref_sha: 'base-ref-sha',
		existing_blob_sha: 'readme-blob-sha',
		state: 'open',
		next_chunk_index: 0,
		next_byte_offset: 0,
		received_bytes: 0,
		chunk_count: 0,
		chunk_byte_lengths: [],
		commit_attempts: 0,
		created_at: '2026-04-06T00:00:00.000Z',
		expires_at: '2099-01-01T00:00:00.000Z',
		committed_at: null,
		last_error: null,
		last_failed_at: null,
	};
}

async function createUploadStub(uploadId: string) {
	const id = env.FILE_UPLOADS.idFromName(uploadId);
	const stub = env.FILE_UPLOADS.get(id);
	await stub.fetch('https://upload.internal/start', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			session: createSession(uploadId),
		}),
	});
	return stub;
}

describe('upload session durable object', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('treats duplicate chunk retransmission as idempotent', async () => {
		const stub = await createUploadStub('upload-duplicate');
		const firstChunk = '# Hello\n';
		const appendPayload = {
			chunk_b64: btoa(firstChunk),
			chunk_index: 0,
			byte_offset: 0,
		};

		const firstResponse = await stub.fetch('https://upload.internal/append', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(appendPayload),
		});
		expect(firstResponse.status).toBe(200);
		await expect(firstResponse.json()).resolves.toMatchObject({
			ok: true,
			duplicate: false,
			idempotent: false,
			next_chunk_index: 1,
			next_byte_offset: firstChunk.length,
		});

		const duplicateResponse = await stub.fetch('https://upload.internal/append', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(appendPayload),
		});
		expect(duplicateResponse.status).toBe(200);
		await expect(duplicateResponse.json()).resolves.toMatchObject({
			ok: true,
			duplicate: true,
			idempotent: true,
			next_chunk_index: 1,
			next_byte_offset: firstChunk.length,
		});
	});

	it('keeps commit failures observable and retryable', async () => {
		const stub = await createUploadStub('upload-retry');
		const chunkOne = '# Hello\n';
		const chunkTwo = 'World!\nDone\n';
		for (const payload of [
			{ chunk_b64: btoa(chunkOne), chunk_index: 0, byte_offset: 0 },
			{ chunk_b64: btoa(chunkTwo), chunk_index: 1, byte_offset: chunkOne.length },
		]) {
			const appendResponse = await stub.fetch('https://upload.internal/append', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			expect(appendResponse.status).toBe(200);
		}

		let commitAttempts = 0;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.github.com/app/installations/116782548/access_tokens') {
				return new Response(
					JSON.stringify({
						token: 'test-installation-token',
						expires_at: '2099-01-01T00:00:00Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/ref/heads/agent/upload-session-test') {
				return new Response(
					JSON.stringify({
						object: { sha: 'base-ref-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/contents/README.md?ref=agent%2Fupload-session-test') {
				return new Response(
					JSON.stringify({
						path: 'README.md',
						type: 'file',
						sha: 'readme-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/commits/base-ref-sha') {
				return new Response(
					JSON.stringify({
						tree: { sha: 'base-tree-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/blobs') {
				return new Response(
					JSON.stringify({
						sha: 'uploaded-blob-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/trees') {
				commitAttempts += 1;
				if (commitAttempts === 1) {
					return new Response(JSON.stringify({ message: 'temporary tree failure' }), {
						status: 500,
						headers: { 'content-type': 'application/json' },
					});
				}
				return new Response(
					JSON.stringify({
						sha: 'uploaded-tree-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (
				url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/commits' &&
				(init?.method ?? 'GET').toUpperCase() === 'POST'
			) {
				return new Response(
					JSON.stringify({
						sha: 'uploaded-commit-sha',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.github.com/repos/iusung111/Project_OpenGPT/git/refs/heads/agent/upload-session-test') {
				return new Response(
					JSON.stringify({
						ref: 'refs/heads/agent/upload-session-test',
						object: { sha: 'uploaded-commit-sha' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			});
		});

		const failedCommitResponse = await stub.fetch('https://upload.internal/commit', {
			method: 'POST',
		});
		expect(failedCommitResponse.status).toBe(400);
		await expect(failedCommitResponse.json()).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining('temporary tree failure'),
			session: {
				state: 'open',
				commit_attempts: 1,
				last_error: expect.stringContaining('temporary tree failure'),
				last_failed_at: expect.any(String),
				next_chunk_index: 2,
				next_byte_offset: 20,
			},
		});

		const successfulCommitResponse = await stub.fetch('https://upload.internal/commit', {
			method: 'POST',
		});
		expect(successfulCommitResponse.status).toBe(200);
		await expect(successfulCommitResponse.json()).resolves.toMatchObject({
			ok: true,
			session: {
				state: 'committed',
				commit_attempts: 2,
				last_error: null,
				last_failed_at: null,
			},
			result: {
				content: {
					path: 'README.md',
					sha: 'uploaded-blob-sha',
				},
				commit: {
					sha: 'uploaded-commit-sha',
				},
			},
		});
	});
});
