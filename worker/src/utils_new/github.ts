import { AppEnv, QueueEnvelope, ToolResultEnvelope } from '../types';
import { diagnosticLog, QUEUE_FETCH_TIMEOUT_MS } from './common';

export function encodeGitHubPath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

export function encodeGitHubRef(ref: string): string {
	return ref.split('/').map(encodeURIComponent).join('/');
}

export function encodeBase64Text(text: string | null | undefined): string {
	if (!text) return '';
	return btoa(
		Array.from(new TextEncoder().encode(text))
			.map((b) => String.fromCharCode(b))
			.join(''),
	);
}

export function decodeBase64Text(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\n/g, '')), (char) => char.charCodeAt(0)));
	} catch {
		return null;
	}
}

export async function queueFetch(env: AppEnv, payload: QueueEnvelope): Promise<Response> {
	const id = env.JOB_QUEUE.idFromName('global-job-queue');
	const stub = env.JOB_QUEUE.get(id);
	const startedAt = Date.now();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort('queue_timeout'), QUEUE_FETCH_TIMEOUT_MS);
	try {
		const response = await stub.fetch('https://queue.internal/queue', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		diagnosticLog('queue_fetch', {
			action: payload.action,
			status: response.status,
			duration_ms: Date.now() - startedAt,
		});
		return response;
	} catch (error) {
		diagnosticLog('queue_fetch_error', {
			action: payload.action,
			duration_ms: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function queueJson(
	env: AppEnv,
	payload: QueueEnvelope,
): Promise<ToolResultEnvelope> {
	try {
		const response = await queueFetch(env, payload);
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('application/json')) {
			const json = (await response.json()) as ToolResultEnvelope;
			if (!response.ok) {
				return {
					ok: false,
					code: json.code ?? 'queue_fetch_failed',
					error: json.error ?? `queue api failed with status ${response.status}`,
					data: json.data,
					meta: json.meta,
				};
			}
			return json;
		}
		if (!response.ok) {
			const text = await response.text();
			return { ok: false, code: 'queue_fetch_failed', error: `queue api failed: ${response.status} ${text}` };
		}
		throw new Error('queue response was not JSON');
	} catch (error) {
		return {
			ok: false,
			code: 'queue_fetch_error',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function activateRepoWorkspace(env: AppEnv, repoKey: string): Promise<void> {
	try {
		await queueJson(env, { action: 'workspace_activate', repo_key: repoKey });
	} catch (error) {
		diagnosticLog('workspace_activate_error', {
			repo_key: repoKey,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
