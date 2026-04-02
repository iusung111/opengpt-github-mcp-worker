import {
	DispatchRequestRecord,
	JobAttentionManifest,
	JobBrowserManifest,
	JobControlManifest,
	JobDesktopManifest,
	JobExecutionManifest,
	JobPreviewManifest,
	JobRuntimeManifest,
	JobVerificationManifest,
	JobWebSessionContext,
	JobWorkerManifest,
	JobWorkflowRunRecord,
	WEB_SESSION_APPROVAL_STATES,
	WEB_SESSION_AUTH_STATES,
	WEB_SESSION_FOLLOWUP_STATES,
	WEB_SESSION_PROVIDERS,
} from './types';
import { normalizeBrowserRemoteControl } from './browser-remote-control';

export const JOB_WORKER_MANIFEST_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDispatchRequest(value: unknown): DispatchRequestRecord | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		typeof value.owner !== 'string' ||
		typeof value.repo !== 'string' ||
		typeof value.workflow_id !== 'string' ||
		typeof value.ref !== 'string' ||
		typeof value.dispatched_at !== 'string'
	) {
		return null;
	}
	return {
		owner: value.owner,
		repo: value.repo,
		workflow_id: value.workflow_id,
		ref: value.ref,
		inputs: isRecord(value.inputs) ? value.inputs : {},
		fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : undefined,
		dispatched_at: value.dispatched_at,
	};
}

function normalizeWorkflowRunRecord(value: unknown): JobWorkflowRunRecord | null {
	if (!isRecord(value)) {
		return null;
	}
	return {
		name: typeof value.name === 'string' ? value.name : undefined,
		status: typeof value.status === 'string' ? value.status : undefined,
		conclusion:
			typeof value.conclusion === 'string' || value.conclusion === null
				? (value.conclusion as string | null)
				: undefined,
		html_url:
			typeof value.html_url === 'string' || value.html_url === null
				? (value.html_url as string | null)
				: undefined,
		run_id: typeof value.run_id === 'number' ? value.run_id : undefined,
		updated_at: typeof value.updated_at === 'string' ? value.updated_at : undefined,
	};
}

function normalizeSection<T extends object>(value: unknown): T {
	return (isRecord(value) ? { ...value } : {}) as T;
}

function normalizeString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEnumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
	if (typeof value !== 'string') {
		return null;
	}
	return allowed.includes(value as T[number]) ? (value as T[number]) : null;
}

function normalizeWebSessionContext(value: unknown): JobWebSessionContext | null {
	if (!isRecord(value)) {
		return null;
	}
	const provider = normalizeEnumValue(value.provider, WEB_SESSION_PROVIDERS);
	const sessionUrl = normalizeString(value.session_url);
	if (provider !== 'chatgpt_web' || !sessionUrl) {
		return null;
	}
	return {
		provider,
		session_url: sessionUrl,
		canonical_conversation_url: normalizeString(value.canonical_conversation_url),
		conversation_id: normalizeString(value.conversation_id),
		page_url_at_attach: normalizeString(value.page_url_at_attach),
		page_title_at_attach: normalizeString(value.page_title_at_attach),
		auth_state: normalizeEnumValue(value.auth_state, WEB_SESSION_AUTH_STATES) ?? 'unknown',
		approval_state: normalizeEnumValue(value.approval_state, WEB_SESSION_APPROVAL_STATES) ?? 'none',
		followup_state: normalizeEnumValue(value.followup_state, WEB_SESSION_FOLLOWUP_STATES) ?? 'unknown',
		can_send_followup: typeof value.can_send_followup === 'boolean' ? value.can_send_followup : null,
		last_user_visible_action: normalizeString(value.last_user_visible_action),
		last_prompt_digest: normalizeString(value.last_prompt_digest),
		last_followup_at: normalizeString(value.last_followup_at),
		linked_job_url: normalizeString(value.linked_job_url),
		updated_at: normalizeString(value.updated_at),
	};
}

function normalizeBrowserManifest(value: unknown): JobBrowserManifest {
	const browser = normalizeSection<JobBrowserManifest>(value);
	const normalized: JobBrowserManifest = { ...browser };
	const remoteControl = normalizeBrowserRemoteControl(browser.remote_control);
	if (Object.prototype.hasOwnProperty.call(browser, 'remote_control') || remoteControl) {
		normalized.remote_control = remoteControl;
	}
	const sessionContext = normalizeWebSessionContext(browser.session_context);
	if (Object.prototype.hasOwnProperty.call(browser, 'session_context') || sessionContext) {
		normalized.session_context = sessionContext;
	}
	return normalized;
}

function mergeBrowserManifest(current: JobBrowserManifest | undefined, patch: unknown): JobBrowserManifest {
	const base = normalizeBrowserManifest(current);
	if (!isRecord(patch)) {
		return base;
	}
	const next: JobBrowserManifest = {
		...base,
		...patch,
	};
	if (Object.prototype.hasOwnProperty.call(patch, 'session_context')) {
		if (patch.session_context === null) {
			next.session_context = null;
		} else {
			const normalizedSessionContext = normalizeWebSessionContext(patch.session_context);
			if (normalizedSessionContext) {
				next.session_context = normalizedSessionContext;
			} else {
				next.session_context = base.session_context;
			}
		}
	}
	return normalizeBrowserManifest(next);
}

export function createEmptyWorkerManifest(): JobWorkerManifest {
	return {
		schema_version: JOB_WORKER_MANIFEST_SCHEMA_VERSION,
		execution: {},
		verification: {},
		preview: {},
		browser: {},
		desktop: {},
		runtime: {},
		attention: {},
		control: {},
		dispatch_request: null,
		last_workflow_run: null,
	};
}

export function normalizeWorkerManifest(value: unknown): JobWorkerManifest {
	const input = isRecord(value) ? value : {};
	const execution = normalizeSection<JobExecutionManifest>(input.execution);
	const verification = normalizeSection<JobVerificationManifest>(input.verification);
	const preview = normalizeSection<JobPreviewManifest>(input.preview);
	const browser = normalizeBrowserManifest(input.browser);
	const desktop = normalizeSection<JobDesktopManifest>(input.desktop);
	const runtime = normalizeSection<JobRuntimeManifest>(input.runtime);
	const attention = normalizeSection<JobAttentionManifest>(input.attention);
	const control = normalizeSection<JobControlManifest>(input.control);

	const dispatchRequest =
		normalizeDispatchRequest(execution.dispatch_request) ?? normalizeDispatchRequest(input.dispatch_request);
	const lastWorkflowRun =
		normalizeWorkflowRunRecord(execution.last_workflow_run) ??
		normalizeWorkflowRunRecord(input.last_workflow_run);

	return {
		...input,
		schema_version: JOB_WORKER_MANIFEST_SCHEMA_VERSION,
		execution: {
			...execution,
			dispatch_request: dispatchRequest,
			last_workflow_run: lastWorkflowRun,
		},
		verification,
		preview,
		browser,
		desktop,
		runtime,
		attention,
		control,
		dispatch_request: dispatchRequest,
		last_workflow_run: lastWorkflowRun,
	};
}

export function mergeWorkerManifest(current: unknown, patch: unknown): JobWorkerManifest {
	const base = normalizeWorkerManifest(current);
	if (!isRecord(patch)) {
		return base;
	}
	const merged = normalizeWorkerManifest({
		...base,
		...patch,
		execution: {
			...(base.execution ?? {}),
			...(isRecord(patch.execution) ? patch.execution : {}),
		},
		verification: {
			...(base.verification ?? {}),
			...(isRecord(patch.verification) ? patch.verification : {}),
		},
		preview: {
			...(base.preview ?? {}),
			...(isRecord(patch.preview) ? patch.preview : {}),
		},
		browser: mergeBrowserManifest(base.browser, patch.browser),
		desktop: {
			...(base.desktop ?? {}),
			...(isRecord(patch.desktop) ? patch.desktop : {}),
		},
		runtime: {
			...(base.runtime ?? {}),
			...(isRecord(patch.runtime) ? patch.runtime : {}),
		},
		attention: {
			...(base.attention ?? {}),
			...(isRecord(patch.attention) ? patch.attention : {}),
		},
		control: {
			...(base.control ?? {}),
			...(isRecord(patch.control) ? patch.control : {}),
		},
	});

	if (Object.prototype.hasOwnProperty.call(patch, 'dispatch_request')) {
		merged.execution = {
			...(merged.execution ?? {}),
			dispatch_request: normalizeDispatchRequest(patch.dispatch_request),
		};
		merged.dispatch_request = merged.execution.dispatch_request ?? null;
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'last_workflow_run')) {
		merged.execution = {
			...(merged.execution ?? {}),
			last_workflow_run: normalizeWorkflowRunRecord(patch.last_workflow_run),
		};
		merged.last_workflow_run = merged.execution.last_workflow_run ?? null;
	}
	return normalizeWorkerManifest(merged);
}

export function getManifestDispatchRequest(manifest: unknown): DispatchRequestRecord | null {
	return normalizeWorkerManifest(manifest).execution?.dispatch_request ?? null;
}

export function getManifestWorkflowRun(manifest: unknown): JobWorkflowRunRecord | null {
	return normalizeWorkerManifest(manifest).execution?.last_workflow_run ?? null;
}

export function setManifestDispatchRequest(
	manifest: unknown,
	dispatchRequest: DispatchRequestRecord | null,
): JobWorkerManifest {
	return normalizeWorkerManifest({
		...normalizeWorkerManifest(manifest),
		dispatch_request: dispatchRequest,
		execution: {
			...(normalizeWorkerManifest(manifest).execution ?? {}),
			dispatch_request: dispatchRequest,
		},
	});
}

export function setManifestWorkflowRun(
	manifest: unknown,
	workflowRun: JobWorkflowRunRecord | null,
): JobWorkerManifest {
	return normalizeWorkerManifest({
		...normalizeWorkerManifest(manifest),
		last_workflow_run: workflowRun,
		execution: {
			...(normalizeWorkerManifest(manifest).execution ?? {}),
			last_workflow_run: workflowRun,
		},
	});
}
