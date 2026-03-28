import {
	DispatchRequestRecord,
	JobAttentionManifest,
	JobBrowserManifest,
	JobDesktopManifest,
	JobExecutionManifest,
	JobPreviewManifest,
	JobRuntimeManifest,
	JobVerificationManifest,
	JobWorkerManifest,
	JobWorkflowRunRecord,
} from './types';

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
		dispatch_request: null,
		last_workflow_run: null,
	};
}

export function normalizeWorkerManifest(value: unknown): JobWorkerManifest {
	const input = isRecord(value) ? value : {};
	const execution = normalizeSection<JobExecutionManifest>(input.execution);
	const verification = normalizeSection<JobVerificationManifest>(input.verification);
	const preview = normalizeSection<JobPreviewManifest>(input.preview);
	const browser = normalizeSection<JobBrowserManifest>(input.browser);
	const desktop = normalizeSection<JobDesktopManifest>(input.desktop);
	const runtime = normalizeSection<JobRuntimeManifest>(input.runtime);
	const attention = normalizeSection<JobAttentionManifest>(input.attention);

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
		browser: {
			...(base.browser ?? {}),
			...(isRecord(patch.browser) ? patch.browser : {}),
		},
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
