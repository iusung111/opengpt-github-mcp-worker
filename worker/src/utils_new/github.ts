import { AppEnv } from '../types';
import { diagnosticLog } from './common';

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
		return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\\n/g, '')), (char) => char.charCodeAt(0)));
	} catch {
		return null;
	}
}

export async function queueJson(
	env: AppEnv,
	payload: Record<string, unknown>,
): Promise<{ ok: boolean; code?: string | null; error?: string | null; data?: Record<string, unknown> | null }> {
	try {
		const id = env.JOB_QUEUE.idFromName('global-job-queue');
		const stub = env.JOB_QUEUE.get(id);
		const response = await stub.fetch('https://queue.internal/queue', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
	});
		if (!response.ok) {
			const text = await response.text();
			return { ok: false, code: 'queue_fetch_failed', error: `queue api failed: ${response.status} ${text}` };
		}
		return (await response.json()) as { ok: boolean; code?: string | null; error?: string | null; data?: Record<string, unknown> | null };
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
		const workspacePath = `/workspaces/${repoKey.replace(/[^/a-zA-Z0-9_.]/g, '_')}`;
		const registerResult = await queueJson(env, {
			action: 'workspace_register',
			workspace: {
				repo_key: repoKey,
				workspace_path: workspacePath,
				display_name: repoKey,
				aliases: [repoKey.split('/').pop() ?? repoKey],
			},
		});
		if (!registerResult.ok) {
			diagnosticLog('workspace_register_failed', {
				repo_key: repoKey,
				code: registerResult.code ?? null,
				error: registerResult.error ?? null,
			});
			return;
		}
		const activateResult = await queueJson(env, { action: 'workspace_activate', repo_key: repoKey });
		if (!activateResult.ok) {
			diagnosticLog('workspace_activate_failed', {
				repo_key: repoKey,
				code: activateResult.code ?? null,
				error: activateResult.error ?? null,
			});
		}
	} catch (error) {
		diagnosticLog('workspace_activate_error', {
			repo_key: repoKey,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
