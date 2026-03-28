import {
	applyHostContextToDocument,
	buildModelContextText,
	createMcpUiBridge,
	extractToolResultEnvelope,
	hasRecord,
} from './bridge-core.mjs';

const root = document.getElementById('notification-app');
if (!root) {
	throw new Error('notification root missing');
}

const config = window.__OPENGPT_GUI_CONFIG__ || {
	mode: 'standalone',
	appOrigin: window.location.origin,
	assetOrigin: window.location.origin,
};

const APP_INFO = {
	name: 'opengpt-run-console',
	title: 'OpenGPT Run Console',
	version: '2.0.0',
	websiteUrl: `${config.appOrigin}/gui/`,
};

const VIEW_STATE_STORAGE_KEY = 'opengpt.run-console.view';
const ATTENTION_STATUSES = ['idle', 'pending_approval', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed'];
const SOURCE_LAYERS = ['gpt', 'mcp', 'cloudflare', 'repo', 'system'];

const DEMO_ENVELOPES = [
	{
		structuredContent: {
			kind: 'opengpt.notification_contract.jobs_list',
			jobs: [
				{
					job_id: 'job-demo-42',
					repo: 'iusung111/OpenGPT',
					next_actor: 'system',
					run_summary: {
						run_id: 'job-demo-42',
						job_id: 'job-demo-42',
						title: 'Mirror deploy verification',
						status: 'pending_approval',
						progress_percent: 72,
						last_event: 'Approval bundle prepared for workflow dispatch and queue control.',
						approval_reason: 'Need workflow approval before redispatching the mirror validation run.',
						updated_at: '2026-03-28T10:20:00.000Z',
						workflow_run_id: 120045,
						pr_number: 23,
						preview_id: 'preview-demo-42',
						control_state: 'active',
					},
					blocking_state: {
						kind: 'approval',
						reason: 'Approval bundle still open.',
						blocked_action: 'workflow_dispatch',
						resume_hint: 'Approve the requested bundle, then resume the run.',
					},
					latest_notification: {
						id: 'notif-demo-approval',
						job_id: 'job-demo-42',
						run_id: 'job-demo-42',
						status: 'pending_approval',
						title: 'Approval requested',
						body: 'Waiting for workflow approval before dispatching the next validation run.',
						source_layer: 'gpt',
						severity: 'warning',
						created_at: '2026-03-28T10:19:42.000Z',
						linked_refs: {
							blocked_action: 'workflow_dispatch',
							request_id: 'req-demo-42',
						},
					},
					notification_counts: {
						idle: 0,
						pending_approval: 2,
						running: 1,
						paused: 0,
						cancelled: 0,
						interrupted: 0,
						completed: 0,
						failed: 0,
					},
					control_state: {
						state: 'active',
						reason: null,
						requested_by: 'gpt',
						requested_at: '2026-03-28T10:15:00.000Z',
						resolved_at: '2026-03-28T10:15:00.000Z',
						resume_strategy: null,
						last_interrupt: null,
					},
					approval_request: {
						pending: true,
						request_id: 'req-demo-42',
						status: 'requested',
						reason: 'Need workflow approval before redispatching the mirror validation run.',
						blocked_action: 'workflow_dispatch',
						requested_at: '2026-03-28T10:19:42.000Z',
					},
				},
				{
					job_id: 'job-demo-43',
					repo: 'iusung111/OpenGPT',
					next_actor: 'system',
					run_summary: {
						run_id: 'job-demo-43',
						job_id: 'job-demo-43',
						title: 'Browser diagnostics collection',
						status: 'running',
						progress_percent: 38,
						last_event: 'Browser diagnostics collected from the preview environment.',
						updated_at: '2026-03-28T10:18:20.000Z',
						workflow_run_id: 120046,
						control_state: 'active',
					},
					blocking_state: {
						kind: 'none',
						reason: null,
						blocked_action: null,
						resume_hint: null,
					},
					latest_notification: {
						id: 'notif-demo-running',
						job_id: 'job-demo-43',
						run_id: 'job-demo-43',
						status: 'running',
						title: 'Diagnostics running',
						body: 'Browser capture is collecting screenshots and console output.',
						source_layer: 'mcp',
						severity: 'info',
						created_at: '2026-03-28T10:18:00.000Z',
					},
				},
			],
		},
		meta: null,
	},
	{
		structuredContent: {
			kind: 'opengpt.notification_contract.job_event_feed',
			items: [
				{
					id: 'feed-approval-1',
					job_id: 'job-demo-42',
					run_id: 'job-demo-42',
					status: 'pending_approval',
					title: 'Approval requested',
					body: 'Waiting for workflow approval before dispatching the next validation run.',
					source_layer: 'gpt',
					severity: 'warning',
					created_at: '2026-03-28T10:19:42.000Z',
					linked_refs: {
						blocked_action: 'workflow_dispatch',
						request_id: 'req-demo-42',
					},
					dedupe_key: 'approval-demo-42',
				},
				{
					id: 'feed-runtime-1',
					job_id: 'job-demo-42',
					run_id: 'job-demo-42',
					status: 'running',
					title: 'Workflow queued',
					body: 'The mirror validation workflow was discovered and queued.',
					source_layer: 'repo',
					severity: 'info',
					created_at: '2026-03-28T10:17:10.000Z',
					linked_refs: {
						workflow_run_id: 120045,
					},
					dedupe_key: 'workflow-demo-42',
				},
			],
			logs: [
				{
					id: 'log-demo-42-1',
					job_id: 'job-demo-42',
					run_id: 'job-demo-42',
					source_layer: 'repo',
					level: 'info',
					message: 'Workflow discovery reconciled run 120045 to job-demo-42.',
					created_at: '2026-03-28T10:17:12.000Z',
					workflow_run_id: 120045,
				},
				{
					id: 'log-demo-42-2',
					job_id: 'job-demo-42',
					run_id: 'job-demo-42',
					source_layer: 'gpt',
					level: 'warning',
					message: 'Approval bundle req-demo-42 is waiting for a human decision.',
					created_at: '2026-03-28T10:19:50.000Z',
				},
			],
			counts: {
				idle: 0,
				pending_approval: 1,
				running: 1,
				paused: 0,
				cancelled: 0,
				interrupted: 0,
				completed: 0,
				failed: 0,
			},
		},
		meta: null,
	},
	{
		structuredContent: {
			kind: 'opengpt.notification_contract.permission_bundle',
			request_id: 'req-demo-42',
			status: 'requested',
			requested_at: '2026-03-28T10:19:42.000Z',
			resolved_at: null,
			notification: {
				id: 'permission-demo-42',
				job_id: 'job-demo-42',
				run_id: 'job-demo-42',
				status: 'pending_approval',
				title: 'Approval requested',
				body: 'Approve workflow dispatch, incident bundle creation, and queue control for this run.',
				source_layer: 'gpt',
				severity: 'warning',
				created_at: '2026-03-28T10:19:42.000Z',
			},
			bundle: {
				repos: ['iusung111/OpenGPT'],
				approved_tools: ['workflow_dispatch', 'job_control', 'incident_bundle_create', 'job_event_feed'],
				approval_request: 'Approve one MCP permission bundle for iusung111/OpenGPT. Scope: Queue and workflow control. Capabilities: queue, workflow, read. Reason: Need workflow approval before redispatching the mirror validation run.',
			},
		},
		meta: null,
	},
	{
		structuredContent: {
			kind: 'opengpt.notification_contract.self_host_status',
			self_repo_key: 'iusung111/opengpt-github-mcp-worker',
			current_deploy: {
				environment: 'live',
				current_url: 'https://worker.example.com',
				release_commit_sha: 'abcdef123456',
			},
			live: {
				url: 'https://worker.example.com',
				healthz: {
					ok: true,
					status: 200,
				},
			},
			mirror: {
				url: 'https://mirror.example.com',
				healthz: {
					ok: true,
					status: 200,
				},
			},
			deploy_strategy: {
				default_target: 'mirror',
				require_mirror_for_live: true,
			},
			warnings: [],
		},
		meta: null,
	},
];

const state = {
	store: createStore(),
	selectedJobId: '',
	selectedNotificationId: '',
	selectedLogId: '',
	focusSection: 'overview',
	approvalNote: '',
	controlNote: '',
	feedFilters: {
		status: '',
		sourceLayer: '',
		limit: 50,
	},
	message: '',
	error: '',
	bridge: null,
	lastPayloadKind: '',
	localSessionCounter: 1,
	lastModelContextKey: '',
};

function createStore() {
	return {
		jobs: {},
		host: {
			context: null,
			capabilities: null,
			info: null,
			protocolVersion: null,
			status: null,
			source: 'standalone',
		},
		toolSessions: {},
		repoIncident: null,
	};
}

function createEmptyCounts() {
	return {
		idle: 0,
		pending_approval: 0,
		running: 0,
		paused: 0,
		cancelled: 0,
		interrupted: 0,
		completed: 0,
		failed: 0,
	};
}

function createEmptyJob(jobId) {
	return {
		jobId,
		repo: '',
		nextActor: '',
		run: null,
		blockingState: {
			kind: 'none',
			reason: null,
			blockedAction: null,
			resumeHint: null,
		},
		latestNotification: null,
		approval: null,
		control: null,
		feed: {
			items: [],
			logs: [],
			counts: createEmptyCounts(),
		},
		incident: null,
		updatedAt: '',
	};
}

function ensureJob(jobId) {
	if (!jobId) return null;
	if (!state.store.jobs[jobId]) {
		state.store.jobs[jobId] = createEmptyJob(jobId);
	}
	return state.store.jobs[jobId];
}

function openaiBridge() {
	return window.openai && typeof window.openai === 'object' ? window.openai : null;
}

function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatTime(value) {
	if (!value) return 'Unknown';
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function selectedAttr(currentValue, optionValue) {
	return currentValue === optionValue ? ' selected' : '';
}

function safeJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return '{}';
	}
}

function statusLabel(status) {
	return String(status || 'idle').replace(/_/g, ' ');
}

function statusTone(status) {
	if (status === 'running') return 'running';
	if (status === 'completed') return 'completed';
	if (status === 'failed') return 'failed';
	if (status === 'pending_approval') return 'pending';
	if (status === 'paused') return 'paused';
	if (status === 'cancelled') return 'cancelled';
	if (status === 'interrupted') return 'interrupted';
	return 'idle';
}

function phaseTone(phase) {
	if (phase === 'completed') return 'completed';
	if (phase === 'cancelled') return 'cancelled';
	if (phase === 'failed' || phase === 'timed_out') return 'failed';
	if (phase === 'waiting') return 'paused';
	return 'pending';
}

function statusPill(status, label = statusLabel(status)) {
	return `<span class="status-pill ${escapeHtml(statusTone(status))}">${escapeHtml(label)}</span>`;
}

function approvalStatusTone(status) {
	if (status === 'requested') return 'pending_approval';
	if (status === 'approved') return 'completed';
	if (status === 'rejected') return 'failed';
	if (status === 'superseded') return 'cancelled';
	if (status === 'expired') return 'interrupted';
	return 'idle';
}

function approvalStatusPill(status) {
	return `<span class="status-pill ${escapeHtml(statusTone(approvalStatusTone(status)))}">${escapeHtml(String(status || 'drafted').replace(/_/g, ' '))}</span>`;
}

function phasePill(phase) {
	return `<span class="status-pill ${escapeHtml(phaseTone(phase))}">${escapeHtml(String(phase || 'pending').replace(/_/g, ' '))}</span>`;
}

function metricChip(label) {
	return `<span class="metric-chip">${escapeHtml(label)}</span>`;
}

function normalizeStatus(value) {
	return ATTENTION_STATUSES.includes(value) ? value : 'idle';
}

function normalizeSeverity(value, fallbackStatus = 'idle') {
	if (value === 'warning') return 'warning';
	if (value === 'error') return 'error';
	if (fallbackStatus === 'failed' || fallbackStatus === 'cancelled' || fallbackStatus === 'interrupted') return 'error';
	if (fallbackStatus === 'pending_approval' || fallbackStatus === 'paused') return 'warning';
	return 'info';
}

function normalizeSourceLayer(value) {
	return SOURCE_LAYERS.includes(value) ? value : 'system';
}

function clampProgress(value) {
	const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
	return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeCounts(value) {
	if (!hasRecord(value)) return null;
	const counts = createEmptyCounts();
	for (const status of ATTENTION_STATUSES) {
		const raw = value[status];
		counts[status] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
	}
	return counts;
}

function computeCountsFromItems(items) {
	const counts = createEmptyCounts();
	for (const item of items) {
		counts[item.status] += 1;
	}
	return counts;
}

function jobAttentionStatus(job) {
	if (!job) return 'idle';
	if (job.control && job.control.state === 'cancelled') return 'cancelled';
	if (job.control && job.control.state === 'paused') return 'paused';
	if (currentInterrupt(job)) return 'interrupted';
	if (job.run) return normalizeStatus(job.run.status);
	return 'idle';
}

function normalizeBlockingState(value) {
	if (!hasRecord(value)) {
		return {
			kind: 'none',
			reason: null,
			blockedAction: null,
			resumeHint: null,
		};
	}
	return {
		kind: typeof value.kind === 'string' ? value.kind : 'none',
		reason: typeof value.reason === 'string' ? value.reason : null,
		blockedAction: typeof value.blocked_action === 'string' ? value.blocked_action : null,
		resumeHint: typeof value.resume_hint === 'string' ? value.resume_hint : null,
	};
}

function normalizeRunSummary(value, jobId, snapshot = {}) {
	const raw = hasRecord(value) ? value : {};
	const resolvedJobId =
		typeof raw.job_id === 'string'
			? raw.job_id
			: typeof snapshot.job_id === 'string'
				? snapshot.job_id
				: jobId || 'run';
	return {
		runId: typeof raw.run_id === 'string' ? raw.run_id : resolvedJobId,
		jobId: resolvedJobId,
		title: typeof raw.title === 'string' && raw.title ? raw.title : resolvedJobId,
		status: normalizeStatus(raw.status),
		progressPercent: clampProgress(raw.progress_percent),
		lastEvent: typeof raw.last_event === 'string' ? raw.last_event : '',
		approvalReason: typeof raw.approval_reason === 'string' ? raw.approval_reason : null,
		updatedAt:
			typeof raw.updated_at === 'string'
				? raw.updated_at
				: typeof snapshot.updated_at === 'string'
					? snapshot.updated_at
					: '',
		workflowRunId: typeof raw.workflow_run_id === 'number' ? raw.workflow_run_id : null,
		prNumber: typeof raw.pr_number === 'number' ? raw.pr_number : null,
		previewId: typeof raw.preview_id === 'string' ? raw.preview_id : null,
		controlState: typeof raw.control_state === 'string' ? raw.control_state : null,
		interruptKind: typeof raw.interrupt_kind === 'string' ? raw.interrupt_kind : null,
		interruptMessage: typeof raw.interrupt_message === 'string' ? raw.interrupt_message : null,
	};
}

function normalizeNotification(value, fallback = {}) {
	if (!hasRecord(value)) return null;
	const jobId =
		typeof value.job_id === 'string'
			? value.job_id
			: typeof fallback.jobId === 'string'
				? fallback.jobId
				: 'run';
	const runId =
		typeof value.run_id === 'string'
			? value.run_id
			: typeof fallback.runId === 'string'
				? fallback.runId
				: jobId;
	const status = normalizeStatus(value.status);
	return {
		id:
			typeof value.id === 'string'
				? value.id
				: `${jobId}:${status}:${typeof value.created_at === 'string' ? value.created_at : 'now'}`,
		jobId,
		runId,
		status,
		title: typeof value.title === 'string' && value.title ? value.title : 'Notification',
		body: typeof value.body === 'string' ? value.body : '',
		sourceLayer: normalizeSourceLayer(value.source_layer),
		severity: normalizeSeverity(value.severity, status),
		createdAt: typeof value.created_at === 'string' ? value.created_at : '',
		linkedRefs: hasRecord(value.linked_refs) ? value.linked_refs : {},
		dedupeKey: typeof value.dedupe_key === 'string' ? value.dedupe_key : '',
		raw: value,
	};
}

function normalizeLogEntry(value, fallback = {}) {
	if (!hasRecord(value)) return null;
	const jobId =
		typeof value.job_id === 'string'
			? value.job_id
			: typeof fallback.jobId === 'string'
				? fallback.jobId
				: 'run';
	const runId =
		typeof value.run_id === 'string'
			? value.run_id
			: typeof fallback.runId === 'string'
				? fallback.runId
				: jobId;
	return {
		id:
			typeof value.id === 'string'
				? value.id
				: `${jobId}:${typeof value.source_layer === 'string' ? value.source_layer : 'system'}:${typeof value.created_at === 'string' ? value.created_at : 'now'}`,
		jobId,
		runId,
		sourceLayer: normalizeSourceLayer(value.source_layer),
		level: value.level === 'warning' || value.level === 'error' ? value.level : 'info',
		message: typeof value.message === 'string' ? value.message : '',
		createdAt: typeof value.created_at === 'string' ? value.created_at : '',
		workflowRunId: typeof value.workflow_run_id === 'number' ? value.workflow_run_id : null,
		raw: value,
	};
}

function normalizeControlState(value) {
	if (!hasRecord(value)) return null;
	const lastInterrupt = hasRecord(value.last_interrupt)
		? {
				kind: typeof value.last_interrupt.kind === 'string' ? value.last_interrupt.kind : null,
				source: typeof value.last_interrupt.source === 'string' ? value.last_interrupt.source : null,
				message: typeof value.last_interrupt.message === 'string' ? value.last_interrupt.message : null,
				recordedAt: typeof value.last_interrupt.recorded_at === 'string' ? value.last_interrupt.recorded_at : null,
		  }
		: null;
	return {
		state: typeof value.state === 'string' ? value.state : null,
		reason: typeof value.reason === 'string' ? value.reason : null,
		requestedBy: typeof value.requested_by === 'string' ? value.requested_by : null,
		requestedAt: typeof value.requested_at === 'string' ? value.requested_at : null,
		resolvedAt: typeof value.resolved_at === 'string' ? value.resolved_at : null,
		resumeStrategy: typeof value.resume_strategy === 'string' ? value.resume_strategy : null,
		lastInterrupt,
	};
}

function normalizeApprovalState(value) {
	if (!hasRecord(value)) return null;
	return {
		pending: Boolean(value.pending),
		requestId: typeof value.request_id === 'string' ? value.request_id : null,
		status: typeof value.status === 'string' ? value.status : null,
		reason: typeof value.reason === 'string' ? value.reason : null,
		blockedAction: typeof value.blocked_action === 'string' ? value.blocked_action : null,
		bundle: hasRecord(value.bundle) ? value.bundle : null,
		note: typeof value.note === 'string' ? value.note : null,
		requestedAt: typeof value.requested_at === 'string' ? value.requested_at : null,
		resolvedAt: typeof value.resolved_at === 'string' ? value.resolved_at : null,
		clearedAt: typeof value.cleared_at === 'string' ? value.cleared_at : null,
	};
}

function normalizePermissionPayload(value) {
	if (!hasRecord(value) || value.kind !== 'opengpt.notification_contract.permission_bundle') return null;
	const notification = normalizeNotification(value.notification, {
		jobId: hasRecord(value.current_progress) && typeof value.current_progress.job_id === 'string' ? value.current_progress.job_id : state.selectedJobId,
	});
	return {
		requestId: typeof value.request_id === 'string' ? value.request_id : null,
		status: typeof value.status === 'string' ? value.status : null,
		requestedAt: typeof value.requested_at === 'string' ? value.requested_at : null,
		resolvedAt: typeof value.resolved_at === 'string' ? value.resolved_at : null,
		bundle: hasRecord(value.bundle) ? value.bundle : null,
		notification,
		currentProgress: hasRecord(value.current_progress) ? value.current_progress : null,
	};
}

function normalizeIncidentPayload(value) {
	if (!hasRecord(value) || value.kind !== 'opengpt.notification_contract.incident_bundle') return null;
	const layerLogs = Array.isArray(value.layer_logs) ? value.layer_logs.map((entry) => normalizeLogEntry(entry)).filter(Boolean) : [];
	const errorLogs = Array.isArray(value.error_logs)
		? value.error_logs
				.map((entry, index) =>
					normalizeLogEntry(
						hasRecord(entry)
							? entry
							: {
									id: `incident-error-${index}`,
									level: 'error',
									message: String(entry),
									source_layer: 'system',
							  },
					),
				)
				.filter(Boolean)
		: [];
	return {
		bundleId: typeof value.bundle_id === 'string' ? value.bundle_id : '',
		repo: typeof value.repo === 'string' ? value.repo : '',
		scope: typeof value.scope === 'string' ? value.scope : 'job',
		summary: hasRecord(value.summary) ? value.summary : null,
		artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
		preview: hasRecord(value.preview) ? value.preview : null,
		browser: hasRecord(value.browser) ? value.browser : null,
		layerLogs,
		errorLogs,
		runs: Array.isArray(value.runs) ? value.runs : [],
		raw: value,
	};
}

function normalizeHostStatus(value) {
	if (!hasRecord(value) || value.kind !== 'opengpt.notification_contract.self_host_status') return null;
	return {
		selfRepoKey: typeof value.self_repo_key === 'string' ? value.self_repo_key : '',
		live: hasRecord(value.live) ? value.live : null,
		mirror: hasRecord(value.mirror) ? value.mirror : null,
		deployStrategy: hasRecord(value.deploy_strategy) ? value.deploy_strategy : null,
		currentDeploy: hasRecord(value.current_deploy) ? value.current_deploy : null,
		workflowAllowlist: hasRecord(value.workflow_allowlist) ? value.workflow_allowlist : null,
		readObservability: hasRecord(value.read_observability) ? value.read_observability : null,
		warnings: Array.isArray(value.warnings) ? value.warnings.map((item) => String(item)) : [],
		raw: value,
	};
}

function upsertFeedItem(job, item) {
	const key = item.dedupeKey || item.id;
	const existingIndex = job.feed.items.findIndex((entry) => (entry.dedupeKey || entry.id) === key);
	if (existingIndex >= 0) {
		job.feed.items[existingIndex] = item;
	} else {
		job.feed.items.push(item);
	}
	job.feed.items.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
	if (job.feed.items.length > 50) {
		job.feed.items = job.feed.items.slice(0, 50);
	}
}

function mergeJobSnapshot(job, snapshot) {
	if (!job || !hasRecord(snapshot)) return;
	if (typeof snapshot.repo === 'string') {
		job.repo = snapshot.repo;
	}
	if (typeof snapshot.next_actor === 'string') {
		job.nextActor = snapshot.next_actor;
	}
	if (hasRecord(snapshot.run_summary)) {
		job.run = normalizeRunSummary(snapshot.run_summary, job.jobId, snapshot);
	}
	if (hasRecord(snapshot.blocking_state)) {
		job.blockingState = normalizeBlockingState(snapshot.blocking_state);
	}
	if (hasRecord(snapshot.control_state)) {
		job.control = normalizeControlState(snapshot.control_state);
	}
	if (hasRecord(snapshot.approval_request)) {
		job.approval = normalizeApprovalState(snapshot.approval_request);
	}
	if (hasRecord(snapshot.latest_notification)) {
		const notification = normalizeNotification(snapshot.latest_notification, {
			jobId: job.jobId,
			runId: job.run ? job.run.runId : job.jobId,
		});
		if (notification) {
			job.latestNotification = notification;
			upsertFeedItem(job, notification);
		}
	}
	const counts = normalizeCounts(snapshot.notification_counts);
	if (counts) {
		job.feed.counts = counts;
	}
	if (typeof snapshot.updated_at === 'string') {
		job.updatedAt = snapshot.updated_at;
	} else if (job.run && job.run.updatedAt) {
		job.updatedAt = job.run.updatedAt;
	}
}

function mergePermissionIntoJob(job, payload) {
	if (!job || !payload) return;
	job.approval = {
		...(job.approval || {}),
		pending: payload.status === 'requested',
		requestId: payload.requestId,
		status: payload.status,
		bundle: payload.bundle,
		requestedAt: payload.requestedAt,
		resolvedAt: payload.resolvedAt,
	};
	if (payload.notification) {
		job.latestNotification = payload.notification;
		upsertFeedItem(job, payload.notification);
	}
	if (payload.currentProgress) {
		mergeJobSnapshot(job, payload.currentProgress);
	}
}

function mergeIncidentIntoStore(payload, sessionId) {
	const incident = normalizeIncidentPayload(payload);
	if (!incident) return;
	state.store.repoIncident = incident;
	if (incident.runs.length) {
		for (const rawRun of incident.runs) {
			const jobId =
				hasRecord(rawRun) && typeof rawRun.job_id === 'string'
					? rawRun.job_id
					: hasRecord(rawRun) && hasRecord(rawRun.run_summary) && typeof rawRun.run_summary.job_id === 'string'
						? rawRun.run_summary.job_id
						: state.selectedJobId;
			if (!jobId) continue;
			const job = ensureJob(jobId);
			mergeJobSnapshot(job, rawRun);
			job.incident = {
				...incident,
				layerLogs: incident.layerLogs.filter((entry) => !entry.jobId || entry.jobId === jobId),
				errorLogs: incident.errorLogs.filter((entry) => !entry.jobId || entry.jobId === jobId),
			};
			if (sessionId) {
				assignSessionJob(sessionId, jobId);
			}
		}
	} else if (state.selectedJobId) {
		const job = ensureJob(state.selectedJobId);
		job.incident = incident;
		if (sessionId) {
			assignSessionJob(sessionId, state.selectedJobId);
		}
	}
}

function assignSessionJob(sessionId, jobId) {
	if (!sessionId || !jobId || !state.store.toolSessions[sessionId]) return;
	state.store.toolSessions[sessionId] = {
		...state.store.toolSessions[sessionId],
		jobId,
	};
}

function deriveJobIdFromStructured(value) {
	if (!hasRecord(value)) return '';
	if (value.kind === 'opengpt.notification_contract.job_progress') {
		return hasRecord(value.progress) && typeof value.progress.job_id === 'string' ? value.progress.job_id : '';
	}
	if (value.kind === 'opengpt.notification_contract.permission_bundle') {
		if (hasRecord(value.current_progress) && typeof value.current_progress.job_id === 'string') {
			return value.current_progress.job_id;
		}
		if (hasRecord(value.notification) && typeof value.notification.job_id === 'string') {
			return value.notification.job_id;
		}
		return '';
	}
	if (value.kind === 'opengpt.notification_contract.jobs_list') {
		return Array.isArray(value.jobs) && hasRecord(value.jobs[0]) && typeof value.jobs[0].job_id === 'string' ? value.jobs[0].job_id : '';
	}
	if (value.kind === 'opengpt.notification_contract.job_event_feed') {
		return Array.isArray(value.items) && hasRecord(value.items[0]) && typeof value.items[0].job_id === 'string' ? value.items[0].job_id : '';
	}
	if (value.kind === 'opengpt.notification_contract.incident_bundle') {
		return Array.isArray(value.runs) && hasRecord(value.runs[0]) && typeof value.runs[0].job_id === 'string' ? value.runs[0].job_id : '';
	}
	return '';
}

function applyStructuredContent(structuredContent, meta = null, sessionId = null) {
	if (!hasRecord(structuredContent)) return;
	state.lastPayloadKind = typeof structuredContent.kind === 'string' ? structuredContent.kind : state.lastPayloadKind;
	if (state.store.host.source === 'standalone' && currentBridgeLabel() !== 'Standalone preview') {
		state.store.host.source = currentBridgeLabel();
	}

	if (structuredContent.kind === 'opengpt.notification_contract.job_progress') {
		const jobId = deriveJobIdFromStructured(structuredContent) || state.selectedJobId;
		if (!jobId) return;
		const job = ensureJob(jobId);
		mergeJobSnapshot(job, hasRecord(structuredContent.progress) ? structuredContent.progress : {});
		if (!job.run && hasRecord(structuredContent.run_summary)) {
			job.run = normalizeRunSummary(structuredContent.run_summary, jobId, structuredContent.progress || {});
		}
		if (!state.selectedJobId) state.selectedJobId = jobId;
		if (sessionId) assignSessionJob(sessionId, jobId);
		return;
	}

	if (structuredContent.kind === 'opengpt.notification_contract.jobs_list') {
		const jobs = Array.isArray(structuredContent.jobs) ? structuredContent.jobs : [];
		for (const rawJob of jobs) {
			if (!hasRecord(rawJob) || typeof rawJob.job_id !== 'string') continue;
			const job = ensureJob(rawJob.job_id);
			mergeJobSnapshot(job, rawJob);
			if (!job.run && hasRecord(rawJob.run_summary)) {
				job.run = normalizeRunSummary(rawJob.run_summary, rawJob.job_id, rawJob);
			}
			if (typeof rawJob.repo === 'string') {
				job.repo = rawJob.repo;
			}
			if (typeof rawJob.next_actor === 'string') {
				job.nextActor = rawJob.next_actor;
			}
		}
		if (!state.selectedJobId && jobs.length && hasRecord(jobs[0]) && typeof jobs[0].job_id === 'string') {
			state.selectedJobId = jobs[0].job_id;
		}
		return;
	}

	if (structuredContent.kind === 'opengpt.notification_contract.job_event_feed') {
		const items = Array.isArray(structuredContent.items)
			? structuredContent.items.map((entry) => normalizeNotification(entry, { jobId: state.selectedJobId })).filter(Boolean)
			: [];
		const logs = Array.isArray(structuredContent.logs)
			? structuredContent.logs.map((entry) => normalizeLogEntry(entry, { jobId: state.selectedJobId })).filter(Boolean)
			: [];
		const grouped = new Map();
		for (const item of items) {
			const bucket = grouped.get(item.jobId) || { items: [], logs: [] };
			bucket.items.push(item);
			grouped.set(item.jobId, bucket);
		}
		for (const log of logs) {
			const bucket = grouped.get(log.jobId) || { items: [], logs: [] };
			bucket.logs.push(log);
			grouped.set(log.jobId, bucket);
		}
		if (!grouped.size && state.selectedJobId) {
			grouped.set(state.selectedJobId, { items: [], logs: [] });
		}
		for (const [jobId, bucket] of grouped.entries()) {
			const job = ensureJob(jobId);
			job.feed.items = bucket.items.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
			job.feed.logs = bucket.logs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
			job.feed.counts =
				grouped.size === 1 && hasRecord(structuredContent.counts)
					? normalizeCounts(structuredContent.counts) || computeCountsFromItems(job.feed.items)
					: computeCountsFromItems(job.feed.items);
			if (job.feed.items[0]) {
				job.latestNotification = job.feed.items[0];
			}
			if (!state.selectedJobId) {
				state.selectedJobId = jobId;
			}
			if (sessionId) {
				assignSessionJob(sessionId, jobId);
			}
		}
		return;
	}

	if (structuredContent.kind === 'opengpt.notification_contract.permission_bundle') {
		const permission = normalizePermissionPayload(structuredContent);
		if (!permission) return;
		const jobId =
			(permission.currentProgress && typeof permission.currentProgress.job_id === 'string'
				? permission.currentProgress.job_id
				: permission.notification && permission.notification.jobId
					? permission.notification.jobId
					: state.selectedJobId) || '';
		if (!jobId) return;
		const job = ensureJob(jobId);
		mergePermissionIntoJob(job, permission);
		if (!state.selectedJobId) {
			state.selectedJobId = jobId;
		}
		if (sessionId) {
			assignSessionJob(sessionId, jobId);
		}
		return;
	}

	if (structuredContent.kind === 'opengpt.notification_contract.incident_bundle') {
		mergeIncidentIntoStore(structuredContent, sessionId);
		return;
	}

	if (structuredContent.kind === 'opengpt.notification_contract.self_host_status') {
		state.store.host.status = normalizeHostStatus(structuredContent);
		return;
	}

	if (hasRecord(meta) && hasRecord(meta['opengpt/widget']) && hasRecord(meta['opengpt/widget'].data)) {
		applyStructuredContent(meta['opengpt/widget'].data, null, sessionId);
	}
}

function sortedJobs() {
	return Object.values(state.store.jobs).sort((left, right) => {
		const leftTime = left.run?.updatedAt || left.updatedAt || '';
		const rightTime = right.run?.updatedAt || right.updatedAt || '';
		return String(rightTime).localeCompare(String(leftTime));
	});
}

function currentJob() {
	const jobs = sortedJobs();
	if (!jobs.length) return null;
	if (state.selectedJobId && state.store.jobs[state.selectedJobId]) {
		return state.store.jobs[state.selectedJobId];
	}
	return jobs[0];
}

function currentApproval() {
	const job = currentJob();
	return job ? job.approval : null;
}

function currentIncident() {
	const job = currentJob();
	return job && job.incident ? job.incident : state.store.repoIncident;
}

function currentInterrupt(job = currentJob()) {
	if (!job) return null;
	if (job.control && job.control.lastInterrupt) {
		return job.control.lastInterrupt;
	}
	if (job.run && (job.run.interruptKind || job.run.interruptMessage)) {
		return {
			kind: job.run.interruptKind,
			source: 'system',
			message: job.run.interruptMessage,
			recordedAt: job.run.updatedAt,
		};
	}
	return null;
}

function jobSessions(jobId = currentJob()?.jobId || null) {
	return Object.values(state.store.toolSessions)
		.filter((session) => !jobId || session.jobId === jobId)
		.sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));
}

function latestToolSession(jobId = currentJob()?.jobId || null) {
	return jobSessions(jobId)[0] || null;
}

function currentBridgeLabel() {
	if (state.bridge && state.bridge.isConnected()) return 'MCP Apps host';
	if (openaiBridge()) return 'window.openai fallback';
	return 'Standalone preview';
}

function currentHostApi() {
	const bridge = state.bridge;
	const openai = openaiBridge();
	if (bridge && bridge.isConnected()) {
		return {
			source: 'bridge',
			canCallTools() {
				return bridge.supports('tools/call');
			},
			canSendMessage() {
				return bridge.supports('ui/message');
			},
			canUpdateModelContext() {
				return bridge.supports('ui/update-model-context');
			},
			canOpenLink() {
				return bridge.supports('ui/open-link');
			},
			capabilities() {
				return {
					toolCalls: bridge.supports('tools/call'),
					message: bridge.supports('ui/message'),
					modelContext: bridge.supports('ui/update-model-context'),
					openLink: bridge.supports('ui/open-link'),
					raw: bridge.getState().hostCapabilities,
				};
			},
			callTool(name, args) {
				return bridge.callTool(name, args || {});
			},
			updateModelContext(snapshot) {
				return bridge.updateModelContext({
					content: [{ type: 'text', text: buildModelContextText(snapshot) }],
					structuredContent: snapshot,
				});
			},
			sendMessage(text) {
				return bridge.sendMessage(text);
			},
			openLink(url) {
				return bridge.openLink(url);
			},
			notifySize(height) {
				bridge.notifySize({ height });
				if (openai && typeof openai.notifyIntrinsicHeight === 'function') {
					try {
						openai.notifyIntrinsicHeight(height);
					} catch (error) {
						console.warn(error);
					}
				}
			},
			setOpenInAppUrl() {
				if (openai && typeof openai.setOpenInAppUrl === 'function') {
					try {
						openai.setOpenInAppUrl({ href: `${config.appOrigin}/gui/` });
					} catch (error) {
						console.warn(error);
					}
				}
			},
		};
	}
	if (openai) {
		return {
			source: 'openai',
			canCallTools() {
				return typeof openai.callTool === 'function';
			},
			canSendMessage() {
				return typeof openai.sendFollowUpMessage === 'function';
			},
			canUpdateModelContext() {
				return typeof openai.setWidgetState === 'function';
			},
			canOpenLink() {
				return true;
			},
			capabilities() {
				return {
					toolCalls: typeof openai.callTool === 'function',
					message: typeof openai.sendFollowUpMessage === 'function',
					modelContext: typeof openai.setWidgetState === 'function',
					openLink: true,
					raw: null,
				};
			},
			callTool(name, args) {
				return openai.callTool(name, args || {});
			},
			updateModelContext(snapshot) {
				return typeof openai.setWidgetState === 'function' ? openai.setWidgetState(snapshot) : Promise.resolve(null);
			},
			sendMessage(text) {
				return openai.sendFollowUpMessage(text);
			},
			openLink(url) {
				window.open(url, '_blank', 'noopener');
				return Promise.resolve(null);
			},
			notifySize(height) {
				if (typeof openai.notifyIntrinsicHeight === 'function') {
					try {
						openai.notifyIntrinsicHeight(height);
					} catch (error) {
						console.warn(error);
					}
				}
			},
			setOpenInAppUrl() {
				if (typeof openai.setOpenInAppUrl === 'function') {
					try {
						openai.setOpenInAppUrl({ href: `${config.appOrigin}/gui/` });
					} catch (error) {
						console.warn(error);
					}
				}
			},
		};
	}
	return {
		source: 'standalone',
		canCallTools() {
			return false;
		},
		canSendMessage() {
			return false;
		},
		canUpdateModelContext() {
			return false;
		},
		canOpenLink() {
			return true;
		},
		capabilities() {
			return {
				toolCalls: false,
				message: false,
				modelContext: false,
				openLink: true,
				raw: null,
			};
		},
		callTool() {
			return Promise.reject(new Error('Live MCP calls are only available inside a connected host bridge.'));
		},
		updateModelContext() {
			return Promise.resolve(null);
		},
		sendMessage() {
			return Promise.reject(new Error('Host follow-up messaging is unavailable in this environment.'));
		},
		openLink(url) {
			window.open(url, '_blank', 'noopener');
			return Promise.resolve(null);
		},
		notifySize() {},
		setOpenInAppUrl() {},
	};
}

function coerceToolEnvelope(value) {
	const extracted = extractToolResultEnvelope(value);
	if (extracted && (extracted.structuredContent || extracted.meta)) {
		return extracted;
	}
	if (hasRecord(value) && typeof value.kind === 'string') {
		return { structuredContent: value, meta: null };
	}
	return null;
}

function upsertToolSession(session) {
	if (!hasRecord(session)) return;
	const requestId =
		typeof session.requestId === 'string'
			? session.requestId
			: typeof session.id === 'string'
				? session.id
				: `session-${Date.now()}`;
	const args = hasRecord(session.args) ? session.args : {};
	const existing = state.store.toolSessions[requestId] || {};
	state.store.toolSessions[requestId] = {
		...existing,
		requestId,
		method: typeof session.method === 'string' ? session.method : existing.method || 'tools/call',
		toolName: typeof session.toolName === 'string' ? session.toolName : existing.toolName || (typeof session.method === 'string' ? session.method : 'tool'),
		args,
		jobId:
			typeof session.jobId === 'string'
				? session.jobId
				: typeof args.job_id === 'string'
					? args.job_id
					: existing.jobId || null,
		phase: typeof session.phase === 'string' ? session.phase : existing.phase || 'pending',
		nextStep: typeof session.nextStep === 'string' ? session.nextStep : existing.nextStep || '',
		createdAt: typeof session.createdAt === 'string' ? session.createdAt : existing.createdAt || new Date().toISOString(),
		updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
		resultKind: typeof session.resultKind === 'string' ? session.resultKind : existing.resultKind || null,
		error: typeof session.error === 'string' ? session.error : existing.error || null,
		source: currentBridgeLabel(),
	};
	if (state.store.toolSessions[requestId].jobId) {
		ensureJob(state.store.toolSessions[requestId].jobId);
	}
}

function startLocalSession(method, toolName, args) {
	const requestId = `local-${state.localSessionCounter++}`;
	upsertToolSession({
		requestId,
		method,
		toolName,
		args,
		phase: 'pending',
		nextStep: 'Waiting for the local host bridge to return a result.',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	return requestId;
}

function finishLocalSession(requestId, patch) {
	if (!requestId) return;
	upsertToolSession({
		...(state.store.toolSessions[requestId] || {}),
		requestId,
		...patch,
		updatedAt: new Date().toISOString(),
	});
}

function buildContextSnapshot() {
	const job = currentJob();
	const approval = currentApproval();
	const latestSession = latestToolSession();
	return {
		kind: 'opengpt.run_console.context',
		job_id: job ? job.jobId : null,
		repo: job ? job.repo : null,
		tab: state.focusSection,
		payload_kind: state.lastPayloadKind || null,
		feed_filters: { ...state.feedFilters },
		run_summary: job && job.run
			? {
					run_id: job.run.runId,
					job_id: job.run.jobId,
					title: job.run.title,
					status: job.run.status,
					progress_percent: job.run.progressPercent,
					last_event: job.run.lastEvent,
					approval_reason: job.run.approvalReason,
					updated_at: job.run.updatedAt,
					workflow_run_id: job.run.workflowRunId,
					pr_number: job.run.prNumber,
					preview_id: job.run.previewId,
					control_state: job.run.controlState,
					interrupt_kind: job.run.interruptKind,
					interrupt_message: job.run.interruptMessage,
				}
			: null,
		blocking_state: job
			? {
					kind: job.blockingState.kind,
					reason: job.blockingState.reason,
					blocked_action: job.blockingState.blockedAction,
					resume_hint: job.blockingState.resumeHint,
				}
			: null,
		latest_notification: job && job.latestNotification
			? {
					id: job.latestNotification.id,
					title: job.latestNotification.title,
					body: job.latestNotification.body,
					status: job.latestNotification.status,
					source_layer: job.latestNotification.sourceLayer,
					created_at: job.latestNotification.createdAt,
				}
			: null,
		permission_bundle: approval
			? {
					request_id: approval.requestId,
					status: approval.status,
					bundle: approval.bundle,
				}
			: null,
		latest_tool_session: latestSession
			? {
					request_id: latestSession.requestId,
					tool_name: latestSession.toolName,
					phase: latestSession.phase,
					next_step: latestSession.nextStep,
				}
			: null,
		host: {
			display_mode: state.store.host.context && state.store.host.context.displayMode ? state.store.host.context.displayMode : null,
			platform: state.store.host.context && state.store.host.context.platform ? state.store.host.context.platform : null,
			theme: state.store.host.context && state.store.host.context.theme ? state.store.host.context.theme : null,
		},
	};
}

async function syncModelContext(force = false) {
	const host = currentHostApi();
	if (!host.canUpdateModelContext()) return;
	const snapshot = buildContextSnapshot();
	const key = safeJson(snapshot);
	if (!force && key === state.lastModelContextKey) return;
	state.lastModelContextKey = key;
	await host.updateModelContext(snapshot);
}

function approvalPresetForAction(blockedAction) {
	if (typeof blockedAction !== 'string' || !blockedAction) {
		return 'implementation_with_pr';
	}
	if (
		blockedAction.includes('workflow') ||
		blockedAction.includes('preview') ||
		blockedAction.includes('incident') ||
		blockedAction.includes('browser') ||
		blockedAction.includes('verify')
	) {
		return 'implementation_with_workflow';
	}
	return 'implementation_with_pr';
}

async function runTool(name, args = {}, nextSection = state.focusSection) {
	const host = currentHostApi();
	if (!host.canCallTools()) {
		state.error = 'Live MCP calls are only available inside a connected host bridge.';
		render();
		return null;
	}
	state.error = '';
	state.message = `Running ${name}...`;
	state.focusSection = nextSection;
	render();
	const localSessionId = host.source === 'openai' ? startLocalSession('tools/call', name, args) : null;
	try {
		const result = await host.callTool(name, args);
		if (localSessionId) {
			const envelope = coerceToolEnvelope(result);
			finishLocalSession(localSessionId, {
				phase: 'completed',
				resultKind: envelope && envelope.structuredContent ? envelope.structuredContent.kind : null,
				error: null,
				nextStep: 'Inspect the tool result and decide the next operator action.',
			});
		}
		const envelope = coerceToolEnvelope(result);
		if (!envelope) {
			throw new Error(`${name} returned no widget payload`);
		}
		applyStructuredContent(envelope.structuredContent, envelope.meta, localSessionId);
		const derivedJobId = envelope.structuredContent ? deriveJobIdFromStructured(envelope.structuredContent) : '';
		if (derivedJobId) {
			state.selectedJobId = derivedJobId;
		}
		state.message = `${name} completed successfully.`;
		return envelope;
	} catch (error) {
		if (localSessionId) {
			finishLocalSession(localSessionId, {
				phase: 'failed',
				error: error instanceof Error ? error.message : String(error),
				nextStep: 'Inspect the error and decide whether to retry.',
			});
		}
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
		render();
		return null;
	} finally {
		render();
	}
}

async function refreshCurrentRun() {
	const job = currentJob();
	if (!job) return;
	await runTool('job_progress', { job_id: job.jobId }, 'overview');
}

async function loadJobs() {
	await runTool('jobs_list', {}, 'overview');
}

async function loadFeed() {
	const job = currentJob();
	if (!job) return;
	await runTool(
		'job_event_feed',
		{
			job_id: job.jobId,
			status: state.feedFilters.status || undefined,
			source_layer: state.feedFilters.sourceLayer || undefined,
			limit: state.feedFilters.limit,
		},
		'activity',
	);
}

async function loadHostStatus() {
	await runTool('self_host_status', { include_healthz: true }, 'overview');
}

async function prepareApprovalBundle() {
	const job = currentJob();
	if (!job || !job.repo) return;
	const reason =
		(job.blockingState && job.blockingState.reason) ||
		(job.run && job.run.approvalReason) ||
		'Need approval to continue the current run.';
	await runTool(
		'request_permission_bundle',
		{
			repos: [job.repo],
			preset: approvalPresetForAction(job.blockingState ? job.blockingState.blockedAction : ''),
			reason,
			job_id: job.jobId,
			blocked_action: job.blockingState ? job.blockingState.blockedAction : undefined,
		},
		'approval',
	);
}

async function buildIncidentBundle() {
	const job = currentJob();
	if (!job || !job.repo || !job.repo.includes('/')) return;
	const [owner, repo] = job.repo.split('/');
	await runTool(
		'incident_bundle_create',
		{
			owner,
			repo,
			job_id: job.jobId,
			scope: 'job',
			include_layer_logs: true,
		},
		'control',
	);
}

async function requestApprovalInChat() {
	const host = currentHostApi();
	const approval = currentApproval();
	if (!approval || !approval.bundle || typeof approval.bundle.approval_request !== 'string') {
		state.error = 'Prepare an approval bundle before requesting approval in chat.';
		render();
		return;
	}
	if (!host.canSendMessage()) {
		state.error = 'Host follow-up messaging is unavailable in this environment.';
		render();
		return;
	}
	state.error = '';
	state.message = 'Requesting approval in the host conversation...';
	render();
	try {
		await syncModelContext(true);
		const lines = [approval.bundle.approval_request];
		if (state.approvalNote.trim()) {
			lines.push('', `Operator note: ${state.approvalNote.trim()}`);
		}
		lines.push('', 'After approval, record the outcome in the Run Console and resume the run if execution should continue.');
		await host.sendMessage(lines.join('\n'));
		state.message = 'Approval request sent to the host conversation.';
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
	}
	render();
}

async function resolveApproval(resolution, resumeAfter = false) {
	const job = currentJob();
	const approval = currentApproval();
	if (!job || !approval || !approval.requestId) {
		state.error = 'There is no active approval request to resolve.';
		render();
		return;
	}
	const envelope = await runTool(
		'permission_request_resolve',
		{
			job_id: job.jobId,
			request_id: approval.requestId,
			resolution,
			note: state.approvalNote.trim() || undefined,
		},
		'approval',
	);
	if (resumeAfter && resolution === 'approved' && envelope) {
		await performControl('resume');
	}
}

function currentExpectedState(job) {
	if (!job || !job.run) return undefined;
	if (job.control && (job.control.state === 'paused' || job.control.state === 'cancelled')) {
		return job.control.state;
	}
	return job.run.status;
}

async function performControl(action) {
	const job = currentJob();
	if (!job) return;
	await runTool(
		'job_control',
		{
			job_id: job.jobId,
			action,
			reason: state.controlNote.trim() || undefined,
			expected_state: currentExpectedState(job),
		},
		'control',
	);
}

async function copyApprovalRequest() {
	const approval = currentApproval();
	const requestText =
		approval && approval.bundle && typeof approval.bundle.approval_request === 'string'
			? approval.bundle.approval_request
			: '';
	if (!requestText) {
		state.error = 'No approval request text is available yet.';
		render();
		return;
	}
	try {
		if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
			throw new Error('Clipboard API unavailable');
		}
		await navigator.clipboard.writeText(requestText);
		state.error = '';
		state.message = 'Approval request copied to the clipboard.';
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
	}
	render();
}

function openFullPage() {
	currentHostApi()
		.openLink(`${config.appOrigin}/gui/`)
		.catch((error) => console.warn(error));
}

function restoreViewState() {
	try {
		const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
		if (!raw) return;
		const saved = JSON.parse(raw);
		if (!hasRecord(saved)) return;
		if (typeof saved.selectedJobId === 'string') state.selectedJobId = saved.selectedJobId;
		if (typeof saved.focusSection === 'string') state.focusSection = saved.focusSection;
		if (typeof saved.approvalNote === 'string') state.approvalNote = saved.approvalNote;
		if (typeof saved.controlNote === 'string') state.controlNote = saved.controlNote;
		if (hasRecord(saved.feedFilters)) {
			state.feedFilters = {
				status: typeof saved.feedFilters.status === 'string' ? saved.feedFilters.status : '',
				sourceLayer: typeof saved.feedFilters.sourceLayer === 'string' ? saved.feedFilters.sourceLayer : '',
				limit: Math.max(1, Math.min(200, Number(saved.feedFilters.limit) || 50)),
			};
		}
	} catch (error) {
		console.warn(error);
	}
}

function persistViewState() {
	try {
		window.localStorage.setItem(
			VIEW_STATE_STORAGE_KEY,
			JSON.stringify({
				selectedJobId: state.selectedJobId,
				focusSection: state.focusSection,
				approvalNote: state.approvalNote,
				controlNote: state.controlNote,
				feedFilters: state.feedFilters,
			}),
		);
	} catch (error) {
		console.warn(error);
	}
}

function syncCapture() {
	const job = currentJob();
	const latestSession = latestToolSession();
	const summary = {
		screen: job ? 'run-console-ready' : 'run-console-empty',
		mode: config.mode,
		bridge: currentBridgeLabel(),
		kind: state.lastPayloadKind || null,
		jobId: job ? job.jobId : null,
		repo: job ? job.repo : null,
		status: job && job.run ? job.run.status : 'idle',
		section: state.focusSection,
		latestToolPhase: latestSession ? latestSession.phase : null,
		generatedAt: new Date().toISOString(),
	};
	const text = safeJson(summary);
	const summaryNode = document.getElementById('analysis-summary');
	const preNode = document.getElementById('capture-json');
	if (summaryNode) summaryNode.textContent = text;
	if (preNode) preNode.textContent = text;
}

function renderCountsGrid(counts) {
	const resolved = counts || createEmptyCounts();
	return `<div class="count-grid">${ATTENTION_STATUSES.map(
		(status) => `<article class="count-card"><span>${escapeHtml(statusLabel(status))}</span><strong>${escapeHtml(resolved[status])}</strong></article>`,
	).join('')}</div>`;
}

function renderReferences(job) {
	if (!job || !job.run) return '';
	const refs = [];
	if (job.run.workflowRunId != null) refs.push(metricChip(`workflow ${job.run.workflowRunId}`));
	if (job.run.prNumber != null) refs.push(metricChip(`pr #${job.run.prNumber}`));
	if (job.run.previewId) refs.push(metricChip(`preview ${job.run.previewId}`));
	if (job.approval && job.approval.requestId) refs.push(metricChip(`approval ${job.approval.requestId}`));
	return refs.length ? `<div class="reference-row">${refs.join('')}</div>` : '';
}

function buttonDisabledAttr(disabled) {
	return disabled ? ' disabled' : '';
}

function aggregateRunCounts() {
	const counts = createEmptyCounts();
	for (const job of Object.values(state.store.jobs)) {
		const status = jobAttentionStatus(job);
		counts[status] += 1;
	}
	return counts;
}

function filteredNotifications(job) {
	if (!job) return [];
	return job.feed.items
		.filter((item) => !state.feedFilters.status || item.status === state.feedFilters.status)
		.filter((item) => !state.feedFilters.sourceLayer || item.sourceLayer === state.feedFilters.sourceLayer)
		.slice(0, state.feedFilters.limit);
}

function filteredLogs(job) {
	if (!job) return [];
	return job.feed.logs
		.filter((entry) => !state.feedFilters.sourceLayer || entry.sourceLayer === state.feedFilters.sourceLayer)
		.slice(0, state.feedFilters.limit);
}

function selectedNotification(job) {
	const items = filteredNotifications(job);
	if (!items.length) return null;
	return items.find((item) => item.id === state.selectedNotificationId) || items[0];
}

function selectedLog(job) {
	const logs = filteredLogs(job);
	if (!logs.length) return null;
	return logs.find((entry) => entry.id === state.selectedLogId) || logs[0];
}

function renderKnownRuns() {
	const jobs = sortedJobs();
	return `
		<section class="panel info-panel full-span" id="section-run-list">
			<div class="stack-header">
				<p class="panel-kicker">Known Runs</p>
				<h3>Tracked job snapshots</h3>
				<p class="supporting-copy">The Run Console keeps a normalized store keyed by <code>job_id</code> so run state, approval state, interrupts, control, and tool sessions stay correlated.</p>
			</div>
			<div class="detail-grid">
				${
					jobs.length
						? jobs
								.map((job) => {
									const isSelected = job.jobId === currentJob()?.jobId;
									const controlState = job.control && job.control.state ? job.control.state : job.run?.controlState || 'active';
									const attention = jobAttentionStatus(job);
									return `
										<button type="button" class="selector-card topbar-card${isSelected ? ' is-selected' : ''}" data-select-job="${escapeHtml(job.jobId)}">
											<div class="meta-row">
												${statusPill(attention)}
												${metricChip(`control ${controlState}`)}
											</div>
											<strong>${escapeHtml(job.run ? job.run.title : job.jobId)}</strong>
											<span>${escapeHtml(job.repo || 'Repository pending')}</span>
											<span>${escapeHtml(job.run ? `${job.run.progressPercent}% progress` : 'No run summary')}</span>
											<span>${escapeHtml(job.run && job.run.updatedAt ? formatTime(job.run.updatedAt) : 'No timestamp')}</span>
										</button>
									`;
								})
								.join('')
						: '<article class="empty-card">No run snapshots are loaded yet. Load runs from the host or use the standalone demo seed.</article>'
				}
			</div>
		</section>
	`;
}

function renderHostFacts(host) {
	const capabilities = currentHostApi().capabilities();
	const status = host.status;
	const deployEnvironment =
		status && status.currentDeploy && typeof status.currentDeploy.environment === 'string'
			? status.currentDeploy.environment
			: 'unknown';
	const currentUrl =
		status && status.currentDeploy && typeof status.currentDeploy.current_url === 'string'
			? status.currentDeploy.current_url
			: status && status.live && typeof status.live.url === 'string'
				? status.live.url
				: '';
	return `
		<div class="detail-card">
			<div class="stack-header">
				<p class="panel-kicker">Host Facts</p>
				<h3>Negotiated bridge and deploy facts</h3>
				<p class="supporting-copy">Action availability is driven from the active host capability negotiation instead of raw function presence checks.</p>
			</div>
			<div class="detail-list">
				<div><span>Bridge</span><strong>${escapeHtml(currentBridgeLabel())}</strong></div>
				<div><span>Protocol</span><strong>${escapeHtml(host.protocolVersion || 'not negotiated')}</strong></div>
				<div><span>Platform</span><strong>${escapeHtml(host.context && host.context.platform ? host.context.platform : 'unknown')}</strong></div>
				<div><span>Display</span><strong>${escapeHtml(host.context && host.context.displayMode ? host.context.displayMode : 'unknown')}</strong></div>
				<div><span>Theme</span><strong>${escapeHtml(host.context && host.context.theme ? host.context.theme : 'unknown')}</strong></div>
				<div><span>Deploy target</span><strong>${escapeHtml(deployEnvironment)}</strong></div>
			</div>
			<div class="reference-row">
				${metricChip(`tool calls ${capabilities.toolCalls ? 'on' : 'off'}`)}
				${metricChip(`message ${capabilities.message ? 'on' : 'off'}`)}
				${metricChip(`model context ${capabilities.modelContext ? 'on' : 'off'}`)}
				${metricChip(`open link ${capabilities.openLink ? 'on' : 'off'}`)}
			</div>
			${
				currentUrl
					? `<pre class="detail-json">${escapeHtml(
							safeJson({
								current_url: currentUrl,
								live: status && status.live ? status.live : null,
								mirror: status && status.mirror ? status.mirror : null,
								warnings: status && status.warnings ? status.warnings : [],
							}),
					  )}</pre>`
					: '<article class="empty-card">No host deployment payload has been loaded yet.</article>'
			}
		</div>
	`;
}

function renderLatestToolSession(job) {
	const session = latestToolSession(job ? job.jobId : null);
	if (!session) {
		return `
			<div class="detail-card">
				<div class="stack-header">
					<p class="panel-kicker">Tool Session</p>
					<h3>No MCP activity yet</h3>
				</div>
				<article class="empty-card">Execute a queue or overview tool to populate the live request log.</article>
			</div>
		`;
	}
	return `
		<div class="detail-card">
			<div class="stack-header">
				<p class="panel-kicker">Latest Tool Session</p>
				<h3>${escapeHtml(session.toolName || session.method || 'request')}</h3>
			</div>
			<div class="meta-row">
				${phasePill(session.phase)}
				${metricChip(`request ${session.requestId}`)}
				${session.resultKind ? metricChip(session.resultKind.replace('opengpt.notification_contract.', '')) : ''}
			</div>
			<p class="supporting-copy">${escapeHtml(session.nextStep || 'Inspect the result and choose the next operator action.')}</p>
			<pre class="detail-json">${escapeHtml(safeJson(session.args || {}))}</pre>
		</div>
	`;
}

function renderOverview(job, host) {
	if (!job || !job.run) {
		return `
			<section class="panel hero-panel" id="section-overview" data-section="overview">
				<div class="hero-copy">
					<p class="panel-kicker">Overview</p>
					<h2>No run selected</h2>
					<p class="supporting-copy">Load a job snapshot from the host to inspect approval, interrupt, and queue control state.</p>
					<div class="action-row">
						<button type="button" class="action-button" data-action="load-jobs"${buttonDisabledAttr(!currentHostApi().canCallTools())}>Load runs</button>
						<button type="button" class="action-button secondary" data-action="load-host-status"${buttonDisabledAttr(!currentHostApi().canCallTools())}>Load host status</button>
					</div>
				</div>
				<div class="hero-side">${renderCountsGrid(aggregateRunCounts())}</div>
			</section>
			<section class="panel info-panel">
				<div class="split-grid">
					${renderHostFacts(host)}
					${renderLatestToolSession(null)}
				</div>
			</section>
			${renderKnownRuns()}
		`;
	}
	const controlState = job.control && job.control.state ? job.control.state : job.run.controlState || 'active';
	const attention = jobAttentionStatus(job);
	const blocker =
		job.blockingState && job.blockingState.kind && job.blockingState.kind !== 'none'
			? `${job.blockingState.kind}: ${job.blockingState.reason || 'Operator action required.'}`
			: 'No blocking state is currently active.';
	return `
		<section class="panel hero-panel" id="section-overview" data-section="overview">
			<div class="hero-copy">
				<p class="panel-kicker">Overview</p>
				<h2>${escapeHtml(job.run.title)}</h2>
				<div class="hero-inline">
					${statusPill(attention)}
					${metricChip(`control ${controlState}`)}
					${job.repo ? metricChip(job.repo) : ''}
				</div>
				<p class="lede">${escapeHtml(job.run.lastEvent || blocker)}</p>
				<p class="supporting-copy">${escapeHtml(blocker)}</p>
				${renderReferences(job)}
				<div class="topbar-meta">
					<article class="hero-metric"><span>Progress</span><strong>${escapeHtml(job.run.progressPercent)}%</strong></article>
					<article class="hero-metric"><span>Updated</span><strong>${escapeHtml(formatTime(job.run.updatedAt))}</strong></article>
					<article class="hero-metric"><span>Next actor</span><strong>${escapeHtml(job.nextActor || 'system')}</strong></article>
				</div>
			</div>
			<div class="hero-side">
				${renderCountsGrid(job.feed.counts)}
			</div>
		</section>
		<section class="panel info-panel">
			<div class="split-grid">
				${renderHostFacts(host)}
				${renderLatestToolSession(job)}
			</div>
		</section>
		${renderKnownRuns()}
	`;
}

function renderNotificationList(job) {
	const items = filteredNotifications(job);
	if (!items.length) {
		return '<article class="empty-card">No notifications matched the current feed filter.</article>';
	}
	const selected = selectedNotification(job);
	return `
		<div class="timeline">
			${items
				.map(
					(item) => `
						<button type="button" class="selector-card timeline-item${selected && selected.id === item.id ? ' is-selected' : ''}" data-select-notification="${escapeHtml(item.id)}">
							<span class="timeline-rail ${escapeHtml(statusTone(item.status))}"></span>
							<div class="timeline-body">
								<div class="meta-row">
									${statusPill(item.status)}
									${metricChip(item.sourceLayer)}
									${metricChip(formatTime(item.createdAt))}
								</div>
								<h3>${escapeHtml(item.title)}</h3>
								<p class="supporting-copy">${escapeHtml(item.body || 'No body')}</p>
							</div>
						</button>
					`,
				)
				.join('')}
		</div>
	`;
}

function renderLogList(job) {
	const logs = filteredLogs(job);
	if (!logs.length) {
		return '<article class="empty-card">No layer logs matched the current filter.</article>';
	}
	const selected = selectedLog(job);
	return `
		<div class="log-list">
			${logs
				.map(
					(entry) => `
						<button type="button" class="selector-card log-entry ${escapeHtml(entry.level)}${selected && selected.id === entry.id ? ' is-selected' : ''}" data-select-log="${escapeHtml(entry.id)}">
							<div class="meta-row">
								<span>${escapeHtml(entry.sourceLayer)}</span>
								${metricChip(formatTime(entry.createdAt))}
								${entry.workflowRunId != null ? metricChip(`workflow ${entry.workflowRunId}`) : ''}
							</div>
							<h3>${escapeHtml(entry.level)}</h3>
							<p class="supporting-copy">${escapeHtml(entry.message || 'No message')}</p>
						</button>
					`,
				)
				.join('')}
		</div>
	`;
}

function renderInterruptCard(job) {
	const interrupt = currentInterrupt(job);
	if (!interrupt || (!interrupt.kind && !interrupt.message)) {
		return `
			<div class="detail-card">
				<div class="stack-header">
					<p class="panel-kicker">Interrupts</p>
					<h3>No interrupt recorded</h3>
				</div>
				<article class="empty-card">Host cancellation, workflow timeout, stale reconcile, and approval resolution interrupts will surface here.</article>
			</div>
		`;
	}
	return `
		<div class="detail-card">
			<div class="stack-header">
				<p class="panel-kicker">Interrupts</p>
				<h3>${escapeHtml(interrupt.kind || 'interrupted')}</h3>
			</div>
			<div class="meta-row">
				${statusPill('interrupted')}
				${interrupt.source ? metricChip(interrupt.source) : ''}
				${interrupt.recordedAt ? metricChip(formatTime(interrupt.recordedAt)) : ''}
			</div>
			<p class="supporting-copy">${escapeHtml(interrupt.message || 'No explicit interrupt message was recorded.')}</p>
		</div>
	`;
}

function renderActivity(job) {
	const notification = selectedNotification(job);
	const log = selectedLog(job);
	return `
		<section class="panel action-panel" id="section-activity" data-section="activity">
			<div class="stack-header">
				<p class="panel-kicker">Activity</p>
				<h2>Normalized feed and layer logs</h2>
				<p class="supporting-copy">Notifications and logs are stored per job, then filtered locally by status, source layer, and limit before reloading from MCP when needed.</p>
			</div>
			<form class="filter-row" data-form="feed">
				<select name="feed-status" aria-label="Filter feed by status">
					<option value="">All statuses</option>
					${ATTENTION_STATUSES.map((status) => `<option value="${escapeHtml(status)}"${selectedAttr(state.feedFilters.status, status)}>${escapeHtml(statusLabel(status))}</option>`).join('')}
				</select>
				<select name="feed-source-layer" aria-label="Filter feed by source layer">
					<option value="">All layers</option>
					${SOURCE_LAYERS.map((layer) => `<option value="${escapeHtml(layer)}"${selectedAttr(state.feedFilters.sourceLayer, layer)}>${escapeHtml(layer)}</option>`).join('')}
				</select>
				<input type="number" min="1" max="200" name="feed-limit" value="${escapeHtml(state.feedFilters.limit)}" />
				<button type="submit" class="action-button"${buttonDisabledAttr(!currentHostApi().canCallTools() || !job)}>Load feed</button>
			</form>
			${renderCountsGrid(job ? job.feed.counts : aggregateRunCounts())}
		</section>
		<section class="panel info-panel">
			<div class="split-grid">
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Notifications</p>
						<h3>${escapeHtml(filteredNotifications(job).length)} entries in view</h3>
					</div>
					${renderNotificationList(job)}
				</div>
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Layer Logs</p>
						<h3>${escapeHtml(filteredLogs(job).length)} entries in view</h3>
					</div>
					${renderLogList(job)}
				</div>
			</div>
		</section>
		<section class="panel info-panel">
			<div class="split-grid">
				${renderInterruptCard(job)}
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Selected Detail</p>
						<h3>${escapeHtml(notification ? notification.title : log ? log.level : 'No selection')}</h3>
					</div>
					<pre class="detail-json">${escapeHtml(
						safeJson(notification ? notification.raw : log ? log.raw : { detail: 'Select a notification or log entry to inspect the raw payload.' }),
					)}</pre>
				</div>
			</div>
		</section>
	`;
}

function renderApproval(job, host) {
	const approval = job ? job.approval : null;
	const bundle = approval && approval.bundle ? approval.bundle : null;
	const blockedAction = job && job.blockingState ? job.blockingState.blockedAction : '';
	const requestText = bundle && typeof bundle.approval_request === 'string' ? bundle.approval_request : '';
	const canCallTools = host.canCallTools();
	const canRequestInChat = canCallTools && host.canSendMessage() && host.canUpdateModelContext() && Boolean(requestText);
	const hasRequest = Boolean(approval && approval.requestId);
	return `
		<section class="panel action-panel" id="section-approval" data-section="approval">
			<div class="stack-header">
				<p class="panel-kicker">Approval</p>
				<h2>Human approval and queue resolution</h2>
				<p class="supporting-copy">Prepare the permission bundle, send the approval prompt into the host conversation, then record the outcome back into queue state.</p>
			</div>
			<div class="meta-row">
				${approval && approval.status ? approvalStatusPill(approval.status) : metricChip('no request')}
				${approval && approval.requestId ? metricChip(`request ${approval.requestId}`) : ''}
				${blockedAction ? metricChip(`blocked ${blockedAction}`) : ''}
			</div>
			<div class="field-stack">
				<label for="approval-note">Operator note</label>
				<textarea id="approval-note" class="command-textarea" name="approval-note" placeholder="Add context for the approver or the queue audit log.">${escapeHtml(state.approvalNote)}</textarea>
			</div>
			<div class="action-row">
				<button type="button" class="action-button" data-action="prepare-approval"${buttonDisabledAttr(!canCallTools || !job)}>Prepare bundle</button>
				<button type="button" class="action-button secondary" data-action="request-approval-chat"${buttonDisabledAttr(!canRequestInChat)}>Request in chat</button>
				<button type="button" class="action-button secondary" data-action="copy-approval"${buttonDisabledAttr(!requestText)}>Copy request</button>
			</div>
			<div class="action-row">
				<button type="button" class="mini-button" data-action="approval-approved"${buttonDisabledAttr(!canCallTools || !hasRequest)}>Record approved</button>
				<button type="button" class="mini-button" data-action="approval-rejected"${buttonDisabledAttr(!canCallTools || !hasRequest)}>Record rejected</button>
				<button type="button" class="mini-button" data-action="approval-superseded"${buttonDisabledAttr(!canCallTools || !hasRequest)}>Record superseded</button>
				<button type="button" class="action-button" data-action="approval-approved-continue"${buttonDisabledAttr(!canCallTools || !hasRequest)}>Approve and continue</button>
			</div>
		</section>
		<section class="panel info-panel">
			<div class="split-grid">
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Bundle Summary</p>
						<h3>${escapeHtml(approval && approval.status ? approval.status : 'Bundle not prepared')}</h3>
					</div>
					<div class="detail-list">
						<div><span>Request id</span><strong>${escapeHtml(approval && approval.requestId ? approval.requestId : 'pending')}</strong></div>
						<div><span>Requested at</span><strong>${escapeHtml(approval && approval.requestedAt ? formatTime(approval.requestedAt) : 'not requested')}</strong></div>
						<div><span>Resolved at</span><strong>${escapeHtml(approval && approval.resolvedAt ? formatTime(approval.resolvedAt) : 'unresolved')}</strong></div>
						<div><span>Reason</span><strong>${escapeHtml(approval && approval.reason ? approval.reason : job && job.blockingState && job.blockingState.reason ? job.blockingState.reason : 'n/a')}</strong></div>
					</div>
					${bundle ? `<pre class="detail-json">${escapeHtml(safeJson(bundle))}</pre>` : '<article class="empty-card">Use "Prepare bundle" to populate the approval contract.</article>'}
				</div>
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Approval Request</p>
						<h3>Human-facing copy</h3>
					</div>
					${
						requestText
							? `<pre class="detail-json">${escapeHtml(requestText)}</pre>`
							: '<article class="empty-card">The approval request text will appear here after the bundle is prepared.</article>'
					}
				</div>
			</div>
		</section>
	`;
}

function renderToolSessions(job) {
	const sessions = jobSessions(job ? job.jobId : null);
	if (!sessions.length) {
		return '<article class="empty-card">No MCP tool sessions have been recorded for this job yet.</article>';
	}
	return `
		<div class="timeline">
			${sessions
				.map(
					(session) => `
						<article class="timeline-item">
							<span class="timeline-rail ${escapeHtml(phaseTone(session.phase))}"></span>
							<div class="timeline-body">
								<div class="meta-row">
									${phasePill(session.phase)}
									${metricChip(session.requestId)}
									${session.resultKind ? metricChip(session.resultKind.replace('opengpt.notification_contract.', '')) : ''}
								</div>
								<h3>${escapeHtml(session.toolName || session.method || 'request')}</h3>
								<p class="supporting-copy">${escapeHtml(session.nextStep || '')}</p>
								<pre class="detail-json">${escapeHtml(
									safeJson({
										args: session.args || {},
										error: session.error || null,
										updated_at: session.updatedAt,
									}),
								)}</pre>
							</div>
						</article>
					`,
				)
				.join('')}
		</div>
	`;
}

function renderIncident(job) {
	const incident = currentIncident(job);
	if (!incident) {
		return '<article class="empty-card">No incident bundle has been built for the selected job.</article>';
	}
	return `
		<div class="detail-card">
			<div class="stack-header">
				<p class="panel-kicker">Incident Bundle</p>
				<h3>${escapeHtml(incident.bundleId || 'bundle')}</h3>
			</div>
			<div class="detail-list">
				<div><span>Scope</span><strong>${escapeHtml(incident.scope || 'job')}</strong></div>
				<div><span>Repo</span><strong>${escapeHtml(incident.repo || job?.repo || 'unknown')}</strong></div>
				<div><span>Artifacts</span><strong>${escapeHtml(Array.isArray(incident.artifacts) ? incident.artifacts.length : 0)}</strong></div>
				<div><span>Layer logs</span><strong>${escapeHtml(incident.layerLogs ? incident.layerLogs.length : 0)}</strong></div>
			</div>
			<pre class="detail-json">${escapeHtml(
				safeJson({
					summary: incident.summary,
					preview: incident.preview,
					browser: incident.browser,
					artifacts: incident.artifacts,
					error_logs: incident.errorLogs,
				}),
			)}</pre>
		</div>
	`;
}

function renderControl(job, host) {
	const runStatus = jobAttentionStatus(job);
	const controlState = job && job.control && job.control.state ? job.control.state : job && job.run ? job.run.controlState || 'active' : 'active';
	const canCallTools = host.canCallTools();
	const canPause = canCallTools && Boolean(job && job.run) && controlState !== 'paused' && controlState !== 'cancelled' && runStatus !== 'completed';
	const canResume = canCallTools && Boolean(job && job.run) && controlState === 'paused';
	const canRetry = canCallTools && Boolean(job && job.run) && (runStatus === 'failed' || runStatus === 'interrupted');
	const canCancel = canCallTools && Boolean(job && job.run) && controlState !== 'cancelled' && runStatus !== 'completed';
	const canRefresh = canCallTools && Boolean(job);
	const canBuildIncident = canCallTools && Boolean(job && job.repo && job.repo.includes('/'));
	const interrupt = currentInterrupt(job);
	return `
		<section class="panel action-panel" id="section-control" data-section="control">
			<div class="stack-header">
				<p class="panel-kicker">Control</p>
				<h2>Pause, resume, retry, cancel, and collect evidence</h2>
				<p class="supporting-copy">Queue-aware control state blocks silent reconcile and auto-redispatch while a run is paused or cancelled.</p>
			</div>
			<div class="meta-row">
				${statusPill(runStatus)}
				${metricChip(`control ${controlState}`)}
				${job && job.control && job.control.resumeStrategy ? metricChip(`resume ${job.control.resumeStrategy}`) : ''}
				${interrupt && interrupt.kind ? metricChip(`interrupt ${interrupt.kind}`) : ''}
			</div>
			<div class="field-stack">
				<label for="control-note">Control note</label>
				<textarea id="control-note" class="command-textarea" name="control-note" placeholder="Explain why the run should pause, resume, retry, or cancel.">${escapeHtml(state.controlNote)}</textarea>
			</div>
			<div class="action-row">
				<button type="button" class="action-button" data-action="control-pause"${buttonDisabledAttr(!canPause)}>Pause</button>
				<button type="button" class="action-button" data-action="control-resume"${buttonDisabledAttr(!canResume)}>Resume</button>
				<button type="button" class="action-button" data-action="control-retry"${buttonDisabledAttr(!canRetry)}>Retry</button>
				<button type="button" class="action-button secondary" data-action="control-cancel"${buttonDisabledAttr(!canCancel)}>Cancel</button>
			</div>
			<div class="action-row">
				<button type="button" class="mini-button" data-action="refresh-run"${buttonDisabledAttr(!canRefresh)}>Refresh run</button>
				<button type="button" class="mini-button" data-action="load-feed"${buttonDisabledAttr(!canRefresh)}>Load feed</button>
				<button type="button" class="mini-button" data-action="build-incident"${buttonDisabledAttr(!canBuildIncident)}>Build incident</button>
			</div>
		</section>
		<section class="panel info-panel">
			<div class="split-grid">
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Tool Sessions</p>
						<h3>Visible MCP request log</h3>
					</div>
					${renderToolSessions(job)}
				</div>
				${renderIncident(job)}
			</div>
		</section>
	`;
}

function renderTopbar(host) {
	const job = currentJob();
	const counts = aggregateRunCounts();
	const canCallTools = currentHostApi().canCallTools();
	return `
		<header class="topbar">
			<div class="hero-copy">
				<p class="eyebrow">MCP Run Console</p>
				<h1>${escapeHtml(APP_INFO.title)}</h1>
				<p class="lede">Queue state, approval lifecycle, interrupt handling, and live MCP tool traffic for actual worker jobs.</p>
				<div class="action-row">
					<button type="button" class="action-button" data-action="load-jobs"${buttonDisabledAttr(!canCallTools)}>Load runs</button>
					<button type="button" class="action-button secondary" data-action="load-host-status"${buttonDisabledAttr(!canCallTools)}>Load host status</button>
					<button type="button" class="mini-button" data-action="open-full-page"${buttonDisabledAttr(!currentHostApi().canOpenLink())}>Open full page</button>
				</div>
			</div>
			<div class="topbar-meta topbar-meta-wide">
				<article class="topbar-card"><span>Bridge</span><strong>${escapeHtml(currentBridgeLabel())}</strong></article>
				<article class="topbar-card"><span>Selected run</span><strong>${escapeHtml(job ? job.jobId : 'none')}</strong></article>
				<article class="topbar-card"><span>Open approvals</span><strong>${escapeHtml(Object.values(state.store.jobs).filter((entry) => entry.approval && entry.approval.status === 'requested').length)}</strong></article>
				<article class="topbar-card"><span>Interrupted runs</span><strong>${escapeHtml(counts.interrupted)}</strong></article>
			</div>
		</header>
	`;
}

function renderNavigation() {
	const tabs = [
		['overview', 'Overview'],
		['activity', 'Activity'],
		['approval', 'Approval'],
		['control', 'Control'],
	];
	return `
		<nav class="tab-row" aria-label="Run console sections">
			${tabs
				.map(
					([key, label]) => `
						<button type="button" class="tab-button${state.focusSection === key ? ' active' : ''}" data-focus-section="${escapeHtml(key)}">${escapeHtml(label)}</button>
					`,
				)
				.join('')}
		</nav>
	`;
}

function render() {
	const job = currentJob();
	const host = currentHostApi();
	root.innerHTML = `
		<div class="app-shell">
			${renderTopbar(state.store.host)}
			${state.message ? `<div class="banner info">${escapeHtml(state.message)}</div>` : ''}
			${state.error ? `<div class="banner error">${escapeHtml(state.error)}</div>` : ''}
			${renderNavigation()}
			<div class="content-shell">
				${renderOverview(job, state.store.host)}
				${renderActivity(job)}
				${renderApproval(job, host)}
				${renderControl(job, host)}
				<section class="panel capture-panel">
					<div class="stack-header">
						<p class="panel-kicker">Capture</p>
						<h2>Widget snapshot</h2>
						<p class="supporting-copy" id="analysis-summary"></p>
					</div>
					<pre class="capture-json" id="capture-json"></pre>
				</section>
			</div>
		</div>
	`;
	persistViewState();
	syncCapture();
	host.notifySize(root.scrollHeight);
}

function hydrateFromEnvelope(envelope) {
	const resolved = coerceToolEnvelope(envelope);
	if (!resolved) return;
	applyStructuredContent(resolved.structuredContent, resolved.meta, null);
	const job = currentJob();
	if (job) {
		state.selectedJobId = job.jobId;
	}
}

function seedDemoStore() {
	if (sortedJobs().length) return;
	for (const envelope of DEMO_ENVELOPES) {
		hydrateFromEnvelope(envelope);
	}
	state.message = 'Loaded standalone demo data. Connect from the MCP host to use live tools.';
}

function hydrate() {
	restoreViewState();
	const globals = hasRecord(window.__OPENGPT_WIDGET_PAYLOAD__)
		? window.__OPENGPT_WIDGET_PAYLOAD__
		: hasRecord(window.__OPENGPT_WIDGET_DATA__)
			? window.__OPENGPT_WIDGET_DATA__
			: null;
	if (globals) {
		hydrateFromEnvelope(globals);
	}
	if (!openaiBridge() && (!window.parent || window.parent === window)) {
		seedDemoStore();
	}
	render();
}

async function connectStandardBridge() {
	currentHostApi().setOpenInAppUrl();
	if (!window.parent || window.parent === window) {
		state.store.host.source = openaiBridge() ? 'window.openai fallback' : 'standalone';
		render();
		return;
	}
	state.bridge = createMcpUiBridge({
		appInfo: APP_INFO,
		onHostContextChanged(hostContext, result) {
			state.store.host.context = hasRecord(hostContext) ? hostContext : null;
			state.store.host.capabilities = hasRecord(result) && hasRecord(result.hostCapabilities) ? result.hostCapabilities : state.store.host.capabilities;
			state.store.host.info = hasRecord(result) && hasRecord(result.hostInfo) ? result.hostInfo : state.store.host.info;
			state.store.host.protocolVersion =
				hasRecord(result) && typeof result.protocolVersion === 'string' ? result.protocolVersion : state.store.host.protocolVersion;
			state.store.host.source = 'mcp-apps';
			applyHostContextToDocument(hostContext);
			render();
		},
		onRequestStateChanged(session) {
			upsertToolSession(session);
			render();
		},
		onToolInput(params, method) {
			if (hasRecord(params)) {
				const requestId =
					typeof params.request_id === 'string' || typeof params.request_id === 'number'
						? String(params.request_id)
						: null;
				if (requestId) {
					upsertToolSession({
						requestId,
						method: 'tools/call',
						toolName: typeof params.name === 'string' ? params.name : method,
						args: hasRecord(params.arguments) ? params.arguments : {},
					});
				}
			}
			render();
		},
		onToolResult(result, sessionId) {
			if (sessionId && state.store.toolSessions[sessionId]) {
				const envelope = coerceToolEnvelope(result);
				if (envelope) {
					applyStructuredContent(envelope.structuredContent, envelope.meta, sessionId);
				}
			}
			render();
			void syncModelContext(false).catch((error) => console.warn(error));
		},
		onToolCancelled(_params, sessionId) {
			state.message = sessionId ? `Tool request ${sessionId} was cancelled by the host.` : 'The host cancelled the current tool execution.';
			render();
		},
		onRequestTeardown() {
			state.error = 'The host requested widget teardown. Reopen the widget to continue.';
			render();
		},
		onSoftTimeout(session) {
			if (session && session.toolName) {
				state.message = `${session.toolName} is still running in the host.`;
				render();
			}
		},
	});
	try {
		const bridgeState = await state.bridge.connect();
		state.store.host.context = bridgeState.hostContext;
		state.store.host.capabilities = bridgeState.hostCapabilities;
		state.store.host.info = bridgeState.hostInfo;
		state.store.host.protocolVersion = bridgeState.protocolVersion;
		state.store.host.source = 'mcp-apps';
		if (bridgeState.hostContext) {
			applyHostContextToDocument(bridgeState.hostContext);
		}
		currentHostApi().setOpenInAppUrl();
		state.message = 'Connected to the MCP Apps host.';
		render();
		await syncModelContext(true);
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.store.host.source = openaiBridge() ? 'window.openai fallback' : 'standalone';
		render();
	}
}

root.addEventListener('click', (event) => {
	const target = event.target instanceof Element ? event.target.closest('[data-focus-section],[data-select-job],[data-select-notification],[data-select-log],[data-action]') : null;
	if (!(target instanceof HTMLElement)) return;
	if (target.dataset.focusSection) {
		state.focusSection = target.dataset.focusSection;
		render();
		void syncModelContext(false).catch((error) => console.warn(error));
		window.requestAnimationFrame(() => {
			document.getElementById(`section-${state.focusSection}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
		return;
	}
	if (target.dataset.selectJob) {
		state.selectedJobId = target.dataset.selectJob;
		state.selectedNotificationId = '';
		state.selectedLogId = '';
		render();
		void syncModelContext(false).catch((error) => console.warn(error));
		return;
	}
	if (target.dataset.selectNotification) {
		state.selectedNotificationId = target.dataset.selectNotification;
		render();
		return;
	}
	if (target.dataset.selectLog) {
		state.selectedLogId = target.dataset.selectLog;
		render();
		return;
	}
	switch (target.dataset.action) {
		case 'load-jobs':
			void loadJobs();
			break;
		case 'load-host-status':
			void loadHostStatus();
			break;
		case 'open-full-page':
			openFullPage();
			break;
		case 'refresh-run':
			void refreshCurrentRun();
			break;
		case 'load-feed':
			void loadFeed();
			break;
		case 'prepare-approval':
			void prepareApprovalBundle();
			break;
		case 'request-approval-chat':
			void requestApprovalInChat();
			break;
		case 'copy-approval':
			void copyApprovalRequest();
			break;
		case 'approval-approved':
			void resolveApproval('approved');
			break;
		case 'approval-rejected':
			void resolveApproval('rejected');
			break;
		case 'approval-superseded':
			void resolveApproval('superseded');
			break;
		case 'approval-approved-continue':
			void resolveApproval('approved', true);
			break;
		case 'control-pause':
			void performControl('pause');
			break;
		case 'control-resume':
			void performControl('resume');
			break;
		case 'control-retry':
			void performControl('retry');
			break;
		case 'control-cancel':
			void performControl('cancel');
			break;
		case 'build-incident':
			void buildIncidentBundle();
			break;
		default:
			break;
	}
});

function handleMutableInput(target) {
	if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
		return;
	}
	switch (target.name) {
		case 'approval-note':
			state.approvalNote = target.value;
			break;
		case 'control-note':
			state.controlNote = target.value;
			break;
		case 'feed-status':
			state.feedFilters.status = target.value;
			break;
		case 'feed-source-layer':
			state.feedFilters.sourceLayer = target.value;
			break;
		case 'feed-limit':
			state.feedFilters.limit = Math.max(1, Math.min(200, Number(target.value) || 50));
			break;
		default:
			return;
	}
	persistViewState();
}

root.addEventListener('input', (event) => {
	handleMutableInput(event.target);
});

root.addEventListener('change', (event) => {
	handleMutableInput(event.target);
});

root.addEventListener('submit', (event) => {
	const target = event.target;
	if (!(target instanceof HTMLFormElement)) return;
	if (target.dataset.form === 'feed') {
		event.preventDefault();
		void loadFeed();
	}
});

window.addEventListener('openai:set_globals', (event) => {
	const detail = hasRecord(event.detail) ? event.detail : {};
	if (hasRecord(detail.hostContext)) {
		state.store.host.context = detail.hostContext;
		applyHostContextToDocument(detail.hostContext);
	}
	const payload =
		hasRecord(detail.payload)
			? detail.payload
			: hasRecord(detail.widgetPayload)
				? detail.widgetPayload
				: hasRecord(detail.widgetData)
					? { structuredContent: detail.widgetData, meta: hasRecord(detail.meta) ? detail.meta : null }
					: hasRecord(detail.structuredContent) || hasRecord(detail.meta)
						? detail
						: null;
	if (payload) {
		hydrateFromEnvelope(payload);
	}
	render();
});

hydrate();
void connectStandardBridge();
