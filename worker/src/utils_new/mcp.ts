import { ToolResultEnvelope } from '../types';
import { hasRecord } from './common';

function buildStructuredToolResult(result: ToolResultEnvelope): Record<string, unknown> | undefined {
	if (!result.ok || !hasRecord(result.data)) {
		return undefined;
	}
	const data = result.data;
	if (hasRecord(data.progress) && hasRecord(data.progress.run_summary)) {
		return {
			kind: 'opengpt.notification_contract.job_progress',
			action: typeof data.action === 'string' ? data.action : undefined,
			progress: data.progress,
			run_summary: data.progress.run_summary,
			blocking_state: data.progress.blocking_state ?? null,
			latest_notification: data.progress.latest_notification ?? null,
			notification_counts: data.progress.notification_counts ?? null,
			browser_control: hasRecord(data.progress.browser_control) ? data.progress.browser_control : null,
			resume_strategy: typeof data.resume_strategy === 'string' ? data.resume_strategy : undefined,
			workflow_cancel: hasRecord(data.workflow_cancel) ? data.workflow_cancel : null,
		};
	}
	if (Array.isArray(data.jobs) && data.jobs.some((item) => hasRecord(item) && hasRecord(item.run_summary))) {
		return {
			kind: 'opengpt.notification_contract.jobs_list',
			jobs: data.jobs,
		};
	}
	if (Array.isArray(data.items) && Array.isArray(data.logs) && hasRecord(data.counts)) {
		return {
			kind: 'opengpt.notification_contract.job_event_feed',
			items: data.items,
			logs: data.logs,
			counts: data.counts,
		};
	}
	if (hasRecord(data.bundle) && typeof data.status === 'string') {
		return {
			kind: 'opengpt.notification_contract.permission_bundle',
			request_id: typeof data.request_id === 'string' ? data.request_id : null,
			bundle: data.bundle,
			notification: hasRecord(data.notification) ? data.notification : null,
			status: data.status ?? null,
			requested_at: typeof data.requested_at === 'string' ? data.requested_at : null,
			resolved_at: typeof data.resolved_at === 'string' ? data.resolved_at : null,
			current_progress: hasRecord(data.current_progress) ? data.current_progress : null,
		};
	}
	if (typeof data.bundle_id === 'string' && typeof data.repo === 'string') {
		return {
			kind: 'opengpt.notification_contract.incident_bundle',
			bundle_id: data.bundle_id,
			repo: data.repo,
			scope: data.scope ?? 'job',
			run_id: typeof data.run_id === 'number' ? data.run_id : undefined,
			summary: hasRecord(data.summary) ? data.summary : null,
			artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
			preview: hasRecord(data.preview) ? data.preview : null,
			browser: hasRecord(data.browser) ? data.browser : null,
			runs: data.runs ?? null,
			layer_logs: data.layer_logs ?? null,
			error_logs: data.error_logs ?? null,
		};
	}
	if (typeof data.self_repo_key === 'string' && 'live' in data && 'mirror' in data && 'deploy_strategy' in data) {
		return {
			kind: 'opengpt.notification_contract.self_host_status',
			self_repo_key: data.self_repo_key,
			github: hasRecord(data.github) ? data.github : null,
			workspace: hasRecord(data.workspace) ? data.workspace : null,
			live: hasRecord(data.live) ? data.live : { url: null, healthz: null },
			mirror: hasRecord(data.mirror) ? data.mirror : { url: null, healthz: null },
			deploy_strategy: hasRecord(data.deploy_strategy) ? data.deploy_strategy : {},
			current_deploy: hasRecord(data.current_deploy) ? data.current_deploy : {},
			workflow_allowlist: hasRecord(data.workflow_allowlist) ? data.workflow_allowlist : {},
			read_observability: hasRecord(data.read_observability) ? data.read_observability : {},
			self_deploy_workflow: typeof data.self_deploy_workflow === 'string' ? data.self_deploy_workflow : '',
			recent_self_deploy_runs: Array.isArray(data.recent_self_deploy_runs) ? data.recent_self_deploy_runs : [],
			warnings: Array.isArray(data.warnings) ? data.warnings : [],
		};
	}
	return undefined;
}

function buildToolResultMeta(
	result: ToolResultEnvelope,
	structuredContent: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const baseMeta = hasRecord(result.meta) ? { ...result.meta } : {};
	if (result.ok && hasRecord(result.data) && structuredContent) {
		baseMeta['opengpt/widget'] = {
			version: 1,
			kind: structuredContent.kind ?? null,
			data: result.data,
		};
	}
	return Object.keys(baseMeta).length > 0 ? baseMeta : undefined;
}

export function toolText(result: ToolResultEnvelope): {
	content: [{ type: 'text'; text: string }];
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
	isError?: boolean;
} {
	const structuredContent = buildStructuredToolResult(result);
	const meta = buildToolResultMeta(result, structuredContent);
	return {
		content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
		structuredContent,
		_meta: meta,
		isError: result.ok ? undefined : true,
	};
}

export function ok(data: Record<string, unknown> | null, meta?: Record<string, unknown>): ToolResultEnvelope {
	return { ok: true, data, error: null, code: null, meta: meta ?? null };
}

export function fail(code: string, error: unknown, meta?: Record<string, unknown>): ToolResultEnvelope {
	return {
		ok: false,
		data: null,
		error: error instanceof Error ? error.message : String(error),
		code,
		meta: meta ?? null,
	};
}
