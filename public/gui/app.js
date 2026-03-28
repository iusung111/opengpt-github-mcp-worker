import {
	applyHostContextToDocument,
	buildModelContextText,
	createMcpUiBridge,
	extractStructuredResult,
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

const VIEW_STATE_STORAGE_KEY = 'opengpt.notification-center.view';
const APP_INFO = {
	name: 'opengpt-notification-center',
	title: 'OpenGPT Notification Center',
	version: '1.1.0',
	websiteUrl: `${config.appOrigin}/gui/`,
};

const demoPayload = {
	kind: 'opengpt.notification_contract.jobs_list',
	jobs: [
		{
			job_id: 'job-demo-42',
			repo: 'iusung111/OpenGPT',
			run_summary: {
				run_id: 'job-demo-42',
				job_id: 'job-demo-42',
				title: 'Mirror deploy validation',
				status: 'pending_approval',
				progress_percent: 74,
				last_event: 'Approval bundle prepared for workflow dispatch and branch write.',
				approval_reason: 'Need approval before continuing mirror verification.',
				updated_at: '2026-03-28T10:20:00.000Z',
				workflow_run_id: 120045,
				pr_number: 23,
				preview_id: 'preview-demo-42',
			},
			blocking_state: {
				kind: 'approval',
				reason: 'Approval bundle still open.',
				blocked_action: 'workflow_dispatch',
			},
			latest_notification: {
				id: 'notif-demo-approval',
				job_id: 'job-demo-42',
				run_id: 'job-demo-42',
				status: 'pending_approval',
				title: 'Approval requested',
				body: 'Waiting for approval before dispatching the workflow.',
				source_layer: 'gpt',
				severity: 'warning',
				created_at: '2026-03-28T10:19:42.000Z',
			},
		},
		{
			job_id: 'job-demo-43',
			repo: 'iusung111/OpenGPT',
			run_summary: {
				run_id: 'job-demo-43',
				job_id: 'job-demo-43',
				title: 'Runtime regression triage',
				status: 'running',
				progress_percent: 38,
				last_event: 'Browser diagnostics collected from remote capture.',
				updated_at: '2026-03-28T10:18:20.000Z',
				workflow_run_id: 120046,
			},
		},
	],
};

const state = {
	payload: null,
	toolInput: {},
	tab: 'overview',
	selectedJobId: '',
	cachedRunSummary: null,
	cachedBlockingState: null,
	feedFilters: { status: '', sourceLayer: '', limit: 50 },
	message: '',
	error: '',
	hostContext: null,
	hostCapabilities: null,
	mcpBridge: null,
	lastModelContextKey: '',
};

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

function statusTone(status) {
	if (status === 'running') return 'running';
	if (status === 'completed') return 'completed';
	if (status === 'failed') return 'failed';
	if (status === 'pending_approval') return 'pending';
	return 'idle';
}

function statusLabel(status) {
	return String(status || 'idle').replace(/_/g, ' ');
}

function statusPill(status) {
	return `<span class="status-pill ${escapeHtml(statusTone(status))}">${escapeHtml(statusLabel(status))}</span>`;
}

function restoreViewState() {
	try {
		const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
		if (!raw) return;
		const saved = JSON.parse(raw);
		if (!hasRecord(saved)) return;
		if (typeof saved.tab === 'string') state.tab = saved.tab;
		if (typeof saved.selectedJobId === 'string') state.selectedJobId = saved.selectedJobId;
		if (hasRecord(saved.feedFilters)) {
			state.feedFilters = {
				status: typeof saved.feedFilters.status === 'string' ? saved.feedFilters.status : '',
				sourceLayer: typeof saved.feedFilters.sourceLayer === 'string' ? saved.feedFilters.sourceLayer : '',
				limit: Number(saved.feedFilters.limit) > 0 ? Number(saved.feedFilters.limit) : 50,
			};
		}
	} catch (error) {
		console.warn(error);
	}
}

function persistLocalViewState() {
	try {
		window.localStorage.setItem(
			VIEW_STATE_STORAGE_KEY,
			JSON.stringify({
				tab: state.tab,
				selectedJobId: state.selectedJobId,
				feedFilters: state.feedFilters,
			}),
		);
	} catch (error) {
		console.warn(error);
	}
}

function currentBridgeLabel() {
	if (state.mcpBridge && state.mcpBridge.isConnected()) return 'MCP Apps host';
	if (openaiBridge()) return 'ChatGPT widget';
	return 'Standalone preview';
}

function currentHostApi() {
	const bridge = state.mcpBridge;
	const openai = openaiBridge();
	return {
		canCallTools() {
			return Boolean((bridge && bridge.isConnected()) || (openai && typeof openai.callTool === 'function'));
		},
		canSendMessage() {
			return Boolean((bridge && bridge.isConnected()) || (openai && typeof openai.sendFollowUpMessage === 'function'));
		},
		async callTool(name, args) {
			if (bridge && bridge.isConnected()) {
				return bridge.callTool(name, args || {});
			}
			if (openai && typeof openai.callTool === 'function') {
				return openai.callTool(name, args || {});
			}
			throw new Error('Live MCP calls are only available inside a connected host bridge.');
		},
		async updateModelContext(snapshot) {
			const markdown = buildModelContextText(snapshot);
			if (bridge && bridge.isConnected()) {
				return bridge.updateModelContext({
					content: [{ type: 'text', text: markdown }],
					structuredContent: snapshot,
				});
			}
			if (openai && typeof openai.setWidgetState === 'function') {
				return openai.setWidgetState(snapshot);
			}
			return null;
		},
		async sendMessage(text) {
			if (bridge && bridge.isConnected()) {
				return bridge.sendMessage(text);
			}
			if (openai && typeof openai.sendFollowUpMessage === 'function') {
				return openai.sendFollowUpMessage(text);
			}
			throw new Error('Host follow-up messaging is unavailable in this environment.');
		},
		async openLink(href) {
			if (bridge && bridge.isConnected()) {
				return bridge.openLink(href);
			}
			window.open(href, '_blank', 'noopener');
			return null;
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
		notifySize(height) {
			if (bridge && bridge.isConnected()) {
				bridge.notifySize({ height });
			}
			if (openai && typeof openai.notifyIntrinsicHeight === 'function') {
				try {
					openai.notifyIntrinsicHeight(height);
				} catch (error) {
					console.warn(error);
				}
			}
		},
	};
}

function hostToolOutput() {
	const openai = openaiBridge();
	if (openai && hasRecord(openai.toolOutput)) {
		return openai.toolOutput;
	}
	if (state.mcpBridge && state.mcpBridge.isConnected()) {
		const bridgeState = state.mcpBridge.getState();
		return extractStructuredResult(bridgeState.toolOutput);
	}
	return null;
}

function hostToolInput() {
	const openai = openaiBridge();
	if (openai && hasRecord(openai.toolInput)) {
		return openai.toolInput;
	}
	if (state.mcpBridge && state.mcpBridge.isConnected()) {
		const bridgeState = state.mcpBridge.getState();
		return hasRecord(bridgeState.toolInput) && hasRecord(bridgeState.toolInput.arguments) ? bridgeState.toolInput.arguments : {};
	}
	return {};
}

function splitRepoKey(repoKey) {
	if (typeof repoKey !== 'string' || !repoKey.includes('/')) return null;
	const parts = repoKey.split('/');
	if (parts.length !== 2) return null;
	return { owner: parts[0], repo: parts[1] };
}

function selectedJob(payload) {
	if (!hasRecord(payload) || payload.kind !== 'opengpt.notification_contract.jobs_list') return null;
	const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
	return (
		jobs.find(function (job) {
			return job.job_id === state.selectedJobId;
		}) ||
		jobs[0] ||
		null
	);
}

function currentIncidentRun(payload) {
	if (!hasRecord(payload) || payload.kind !== 'opengpt.notification_contract.incident_bundle') return null;
	const runs = Array.isArray(payload.runs) ? payload.runs : [];
	return (
		runs.find(function (run) {
			return run.job_id === state.selectedJobId;
		}) ||
		runs[0] ||
		null
	);
}

function deriveJobId(payload) {
	if (!hasRecord(payload)) return '';
	if (payload.kind === 'opengpt.notification_contract.job_progress') {
		return payload.progress && payload.progress.job_id ? String(payload.progress.job_id) : '';
	}
	if (payload.kind === 'opengpt.notification_contract.jobs_list') {
		if (state.selectedJobId) return state.selectedJobId;
		const job = selectedJob(payload);
		return job && job.job_id ? String(job.job_id) : '';
	}
	if (payload.kind === 'opengpt.notification_contract.job_event_feed') {
		return Array.isArray(payload.items) && payload.items[0] && payload.items[0].job_id ? String(payload.items[0].job_id) : '';
	}
	if (payload.kind === 'opengpt.notification_contract.permission_bundle') {
		return payload.notification && payload.notification.job_id ? String(payload.notification.job_id) : '';
	}
	if (payload.kind === 'opengpt.notification_contract.incident_bundle') {
		const run = currentIncidentRun(payload);
		return run && run.job_id ? String(run.job_id) : '';
	}
	return '';
}

function currentRepoKey(payload) {
	if (!hasRecord(payload)) return '';
	if (payload.kind === 'opengpt.notification_contract.job_progress') {
		return payload.progress && typeof payload.progress.repo === 'string' ? payload.progress.repo : '';
	}
	if (payload.kind === 'opengpt.notification_contract.jobs_list') {
		const job = selectedJob(payload);
		return job && typeof job.repo === 'string' ? job.repo : '';
	}
	if (payload.kind === 'opengpt.notification_contract.permission_bundle') {
		const repos = payload.bundle && Array.isArray(payload.bundle.repos) ? payload.bundle.repos : [];
		return typeof repos[0] === 'string' ? repos[0] : '';
	}
	if (payload.kind === 'opengpt.notification_contract.incident_bundle') {
		return typeof payload.repo === 'string' ? payload.repo : '';
	}
	return '';
}

function runSummary(payload) {
	if (!hasRecord(payload)) return null;
	if (payload.kind === 'opengpt.notification_contract.job_progress') return payload.run_summary || (payload.progress && payload.progress.run_summary) || null;
	if (payload.kind === 'opengpt.notification_contract.jobs_list') {
		const job = selectedJob(payload);
		return job && job.run_summary ? job.run_summary : null;
	}
	if (payload.kind === 'opengpt.notification_contract.incident_bundle') {
		const run = currentIncidentRun(payload);
		return run && run.run_summary ? run.run_summary : null;
	}
	return state.cachedRunSummary;
}

function blockingState(payload) {
	if (!hasRecord(payload)) return null;
	if (payload.kind === 'opengpt.notification_contract.job_progress') return payload.blocking_state || null;
	if (payload.kind === 'opengpt.notification_contract.jobs_list') {
		const job = selectedJob(payload);
		return job && job.blocking_state ? job.blocking_state : null;
	}
	if (payload.kind === 'opengpt.notification_contract.incident_bundle') {
		const run = currentIncidentRun(payload);
		return run && run.blocking_state ? run.blocking_state : null;
	}
	return state.cachedBlockingState;
}

function latestNotification(payload) {
	if (!hasRecord(payload)) return null;
	if (payload.kind === 'opengpt.notification_contract.job_progress') return payload.latest_notification || null;
	if (payload.kind === 'opengpt.notification_contract.jobs_list') {
		const job = selectedJob(payload);
		return job && job.latest_notification ? job.latest_notification : null;
	}
	if (payload.kind === 'opengpt.notification_contract.permission_bundle') return payload.notification || null;
	if (payload.kind === 'opengpt.notification_contract.incident_bundle') {
		const run = currentIncidentRun(payload);
		return run && run.latest_notification ? run.latest_notification : null;
	}
	return null;
}

function counts(payload) {
	if (!hasRecord(payload)) return null;
	if (payload.kind === 'opengpt.notification_contract.job_progress') return payload.notification_counts || null;
	if (payload.kind === 'opengpt.notification_contract.job_event_feed') return payload.counts || null;
	return null;
}

function refreshContextCache() {
	const summary = runSummary(state.payload);
	const blocker = blockingState(state.payload);
	if (hasRecord(summary)) {
		state.cachedRunSummary = summary;
	}
	if (hasRecord(blocker)) {
		state.cachedBlockingState = blocker;
	}
}

function syncCapture() {
	const summary = {
		screen: state.payload ? 'notification-ready' : 'idle',
		mode: config.mode,
		hostMode: currentBridgeLabel(),
		kind: state.payload && state.payload.kind ? state.payload.kind : null,
		jobId: deriveJobId(state.payload),
		tab: state.tab,
		captureReady: Boolean(state.payload),
		generatedAt: new Date().toISOString(),
	};
	const text = JSON.stringify(summary, null, 2);
	const summaryNode = document.getElementById('analysis-summary');
	const preNode = document.getElementById('capture-json');
	if (summaryNode) summaryNode.textContent = text;
	if (preNode) preNode.textContent = text;
}

function buildModelContextSnapshot() {
	const summary = runSummary(state.payload);
	const blocker = blockingState(state.payload);
	const notification = latestNotification(state.payload);
	return {
		kind: 'opengpt.notification_widget.context',
		job_id: deriveJobId(state.payload) || null,
		repo: currentRepoKey(state.payload) || null,
		tab: state.tab,
		payload_kind: state.payload && state.payload.kind ? state.payload.kind : null,
		feed_filters: { ...state.feedFilters },
		run_summary: summary ? { ...summary } : null,
		blocking_state: blocker ? { ...blocker } : null,
		latest_notification: notification
			? {
					id: notification.id ?? null,
					title: notification.title ?? null,
					body: notification.body ?? null,
					status: notification.status ?? null,
					source_layer: notification.source_layer ?? null,
					created_at: notification.created_at ?? null,
				}
			: null,
		host: {
			mode: currentBridgeLabel(),
			display_mode: state.hostContext && state.hostContext.displayMode ? state.hostContext.displayMode : null,
			locale: state.hostContext && state.hostContext.locale ? state.hostContext.locale : null,
			platform: state.hostContext && state.hostContext.platform ? state.hostContext.platform : null,
			theme: state.hostContext && state.hostContext.theme ? state.hostContext.theme : null,
		},
	};
}

function syncModelContext() {
	const host = currentHostApi();
	const snapshot = buildModelContextSnapshot();
	if (!snapshot.payload_kind || !host.canCallTools()) return;
	const nextKey = JSON.stringify(snapshot);
	if (nextKey === state.lastModelContextKey) return;
	state.lastModelContextKey = nextKey;
	host.updateModelContext(snapshot).catch(function (error) {
		console.warn(error);
	});
}

function persist() {
	persistLocalViewState();
	syncModelContext();
}

function renderReferences(summary) {
	if (!hasRecord(summary)) return '';
	const refs = [];
	if (summary.workflow_run_id) refs.push(`Workflow #${summary.workflow_run_id}`);
	if (summary.pr_number) refs.push(`PR #${summary.pr_number}`);
	if (summary.preview_id) refs.push(`Preview ${summary.preview_id}`);
	return refs.length
		? `<div class="reference-row">${refs
				.map(function (entry) {
					return `<span class="reference-pill">${escapeHtml(entry)}</span>`;
				})
				.join('')}</div>`
		: '';
}

function renderHostFacts() {
	const facts = [];
	if (state.hostContext && state.hostContext.platform) facts.push(state.hostContext.platform);
	if (state.hostContext && state.hostContext.displayMode) facts.push(state.hostContext.displayMode);
	if (state.hostContext && state.hostContext.locale) facts.push(state.hostContext.locale);
	if (state.hostContext && state.hostContext.theme) facts.push(state.hostContext.theme);
	return facts.length ? facts.join(' | ') : 'No host context';
}

function renderJobs(payload) {
	const jobs =
		payload && payload.kind === 'opengpt.notification_contract.jobs_list'
			? payload.jobs
			: payload && payload.kind === 'opengpt.notification_contract.incident_bundle'
				? payload.runs
				: [];
	if (!Array.isArray(jobs) || !jobs.length) return '<div class="empty-card">No jobs available.</div>';
	return `<div class="table-shell"><table class="data-table"><thead><tr><th>Job</th><th>Status</th><th>Last event</th><th></th></tr></thead><tbody>${jobs
		.map(function (job) {
			const summary = job.run_summary || {};
			return `<tr class="${job.job_id === state.selectedJobId ? 'selected-row' : ''}">
				<td><strong>${escapeHtml(job.job_id || 'unknown')}</strong><div class="cell-muted">${escapeHtml(job.repo || 'n/a')}</div></td>
				<td>${statusPill(summary.status || 'idle')}</td>
				<td>${escapeHtml(summary.last_event || 'No event')}</td>
				<td><button class="mini-button" type="button" data-action="open-job" data-job-id="${escapeHtml(job.job_id || '')}">Open</button></td>
			</tr>`;
		})
		.join('')}</tbody></table></div>`;
}

function renderEvents(payload) {
	const items =
		payload && payload.kind === 'opengpt.notification_contract.job_event_feed'
			? payload.items
			: latestNotification(payload)
				? [latestNotification(payload)]
				: [];
	const logs =
		payload && payload.kind === 'opengpt.notification_contract.job_event_feed'
			? payload.logs
			: payload && payload.kind === 'opengpt.notification_contract.incident_bundle'
				? payload.layer_logs
				: [];
	const host = currentHostApi();
	const currentJobId = deriveJobId(payload);
	return `<section class="panel full-span">
		<div class="tab-header">
			<div><p class="panel-kicker">Event feed</p><h3>Notifications and layer logs</h3></div>
			<form class="filter-row" data-form="feed-filters">
				<select name="status"><option value="">All status</option><option value="pending_approval">pending approval</option><option value="running">running</option><option value="completed">completed</option><option value="failed">failed</option></select>
				<select name="sourceLayer"><option value="">All sources</option><option value="gpt">gpt</option><option value="mcp">mcp</option><option value="cloudflare">cloudflare</option><option value="repo">repo</option><option value="system">system</option></select>
				<input name="limit" type="number" min="1" max="200" value="${escapeHtml(state.feedFilters.limit)}" />
				<button class="mini-button" type="submit"${host.canCallTools() && currentJobId ? '' : ' disabled'}>Reload</button>
			</form>
		</div>
		<div class="split-grid">
			<section class="panel compact-panel">${Array.isArray(items) && items.length ? `<div class="timeline">${items
				.map(function (item) {
					return `<article class="timeline-item"><div class="timeline-rail ${escapeHtml(statusTone(item.status))}"></div><div class="timeline-body"><div class="stack-header"><h4>${escapeHtml(item.title || item.id || 'Notification')}</h4>${statusPill(item.status)}</div><p>${escapeHtml(item.body || 'No message')}</p><div class="meta-row"><span>${escapeHtml(item.source_layer || 'system')}</span><span>${escapeHtml(formatTime(item.created_at))}</span></div></div></article>`;
				})
				.join('')}</div>` : '<div class="empty-card">No notification items.</div>'}</section>
			<section class="panel compact-panel">${Array.isArray(logs) && logs.length ? `<div class="log-list">${logs
				.map(function (entry) {
					return `<article class="log-entry ${escapeHtml(entry.level || 'info')}"><div class="stack-header"><h4>${escapeHtml(entry.source_layer || 'system')}</h4><span class="log-level">${escapeHtml(entry.level || 'info')}</span></div><p>${escapeHtml(entry.message || 'No log message')}</p><div class="meta-row"><span>${escapeHtml(entry.job_id || 'no job')}</span><span>${escapeHtml(formatTime(entry.created_at))}</span></div></article>`;
				})
				.join('')}</div>` : '<div class="empty-card">No layer logs.</div>'}</section>
		</div>
	</section>`;
}

function approvalPresetForAction(blockedAction) {
	if (blockedAction === 'workflow_dispatch' || blockedAction === 'preview_env_create') return 'implementation_with_workflow';
	if (blockedAction === 'pr_merge' || (typeof blockedAction === 'string' && blockedAction.startsWith('repo_'))) {
		return 'implementation_with_pr';
	}
	return 'implementation_with_workflow';
}

function render() {
	const summary = runSummary(state.payload);
	const blocker = blockingState(state.payload);
	const notification = latestNotification(state.payload);
	const host = currentHostApi();
	const currentJobId = deriveJobId(state.payload);
	const currentRepo = currentRepoKey(state.payload);
	if (!state.selectedJobId && currentJobId) state.selectedJobId = currentJobId;

	root.innerHTML = `<div class="app-shell ${escapeHtml(config.mode)}">
		<header class="topbar">
			<div><p class="eyebrow">OpenGPT Apps widget</p><h1>Notification Center</h1><p class="lede">Run attention dashboard for queue jobs, approvals, event feeds, and incident bundles.</p></div>
			<div class="topbar-meta topbar-meta-wide">
				<div class="topbar-card"><span>Mode</span><strong>${escapeHtml(currentBridgeLabel())}</strong></div>
				<div class="topbar-card"><span>Host</span><strong>${escapeHtml(renderHostFacts())}</strong></div>
				<div class="topbar-card"><span>Linked job</span><strong>${escapeHtml(currentJobId || 'none')}</strong></div>
				<div class="topbar-card"><span>Payload kind</span><strong>${escapeHtml(state.payload && state.payload.kind ? state.payload.kind.replace('opengpt.notification_contract.', '') : 'none')}</strong></div>
			</div>
		</header>
		${!host.canCallTools() ? `<section class="panel compact-panel standalone-panel"><p class="panel-kicker">Standalone preview</p><h3>Live bridge not attached</h3><p class="supporting-copy">This route renders demo data locally. Open the same widget from ChatGPT or another MCP Apps host to enable direct tool calls.</p></section>` : ''}
		${state.error ? `<section class="banner error">${escapeHtml(state.error)}</section>` : ''}
		${state.message ? `<section class="banner info">${escapeHtml(state.message)}</section>` : ''}
		<nav class="tab-row">
			<button class="tab-button${state.tab === 'overview' ? ' active' : ''}" type="button" data-action="set-tab" data-tab="overview">Overview</button>
			<button class="tab-button${state.tab === 'events' ? ' active' : ''}" type="button" data-action="set-tab" data-tab="events">Events</button>
			<button class="tab-button${state.tab === 'jobs' ? ' active' : ''}" type="button" data-action="set-tab" data-tab="jobs">Jobs</button>
			<button class="tab-button${state.tab === 'incident' ? ' active' : ''}" type="button" data-action="set-tab" data-tab="incident">Incident</button>
		</nav>
		<main class="content-shell">
			<section class="panel hero-panel">
				<div class="hero-copy">
					<p class="eyebrow">Run summary</p>
					<h2>${escapeHtml(summary && summary.title ? summary.title : 'No linked run')}</h2>
					<p class="lede">${escapeHtml(summary && summary.last_event ? summary.last_event : 'This widget becomes fully interactive when a notification tool returns structured output.')}</p>
					<div class="hero-inline">
						${statusPill(summary && summary.status ? summary.status : 'idle')}
						<span class="metric-chip">${escapeHtml(summary && summary.progress_percent != null ? `${summary.progress_percent}% complete` : 'Progress unavailable')}</span>
						<span class="metric-chip">${escapeHtml(summary && summary.updated_at ? `Updated ${formatTime(summary.updated_at)}` : 'No update time')}</span>
					</div>
					${renderReferences(summary)}
				</div>
				<div class="hero-side">
					<div class="hero-metric"><span>Run ID</span><strong>${escapeHtml(summary && summary.run_id ? summary.run_id : 'n/a')}</strong></div>
					<div class="hero-metric"><span>Approval</span><strong>${escapeHtml(summary && summary.approval_reason ? summary.approval_reason : 'Not blocked')}</strong></div>
					<div class="hero-metric"><span>Preview</span><strong>${escapeHtml(summary && summary.preview_id ? summary.preview_id : 'n/a')}</strong></div>
				</div>
			</section>
			<div class="split-grid">
				<section class="panel info-panel">
					<p class="panel-kicker">Blocking state</p>
					<h3>${escapeHtml(blocker && blocker.kind ? blocker.kind : 'none')}</h3>
					<p class="supporting-copy">${escapeHtml(blocker && blocker.reason ? blocker.reason : 'No active blocker.')}</p>
					<div class="detail-list">
						<div><span>Blocked action</span><strong>${escapeHtml(blocker && blocker.blocked_action ? blocker.blocked_action : 'n/a')}</strong></div>
						<div><span>Resume hint</span><strong>${escapeHtml(blocker && blocker.resume_hint ? blocker.resume_hint : 'n/a')}</strong></div>
					</div>
				</section>
				<section class="panel info-panel">
					<p class="panel-kicker">Latest notification</p>
					<h3>${escapeHtml(notification && notification.title ? notification.title : 'No linked notification')}</h3>
					<p class="supporting-copy">${escapeHtml(notification && notification.body ? notification.body : 'Refresh the event feed to pull recent run events into the widget.')}</p>
					<div class="detail-list">
						<div><span>Source</span><strong>${escapeHtml(notification && notification.source_layer ? notification.source_layer : 'system')}</strong></div>
						<div><span>Created</span><strong>${escapeHtml(notification && notification.created_at ? formatTime(notification.created_at) : 'n/a')}</strong></div>
					</div>
				</section>
			</div>
			<section class="panel action-panel">
				<p class="panel-kicker">Widget actions</p>
				<div class="action-row">
					<button class="action-button secondary" type="button" data-action="load-jobs"${host.canCallTools() ? '' : ' disabled'}>Load jobs</button>
					<button class="action-button" type="button" data-action="refresh-current"${host.canCallTools() && currentJobId ? '' : ' disabled'}>Refresh run</button>
					<button class="action-button" type="button" data-action="load-feed"${host.canCallTools() && currentJobId ? '' : ' disabled'}>Load event feed</button>
					<button class="action-button secondary" type="button" data-action="prepare-approval"${host.canCallTools() && currentJobId && currentRepo && blocker && blocker.kind === 'approval' ? '' : ' disabled'}>Prepare approval</button>
					<button class="action-button secondary" type="button" data-action="build-incident"${host.canCallTools() && currentRepo ? '' : ' disabled'}>Build incident</button>
					<button class="action-button secondary" type="button" data-action="ask-assistant"${host.canSendMessage() && state.payload ? '' : ' disabled'}>Ask assistant</button>
					<button class="action-button secondary" type="button" data-action="open-full-page">Open full page</button>
				</div>
				<p class="supporting-copy">${host.canCallTools() ? 'This view can call MCP tools directly through the host bridge and push view context back to the model.' : 'Standalone preview mode only shows demo data.'}</p>
			</section>
			<section class="panel">
				<p class="panel-kicker">Counts</p>
				${hasRecord(counts(state.payload)) ? `<div class="count-grid">${['idle', 'pending_approval', 'running', 'completed', 'failed']
					.map(function (key) {
						return `<article class="count-card"><span>${escapeHtml(statusLabel(key))}</span><strong>${escapeHtml(counts(state.payload)[key] || 0)}</strong></article>`;
					})
					.join('')}</div>` : '<div class="empty-card">No derived counters yet.</div>'}
			</section>
			${state.tab === 'jobs' ? `<section class="panel full-span"><p class="panel-kicker">Jobs</p>${renderJobs(state.payload)}</section>` : ''}
			${state.tab === 'events' ? renderEvents(state.payload) : ''}
			${state.tab === 'incident' ? `<section class="panel full-span"><p class="panel-kicker">Incident bundle</p>${renderJobs(state.payload)}${renderEvents(state.payload)}</section>` : ''}
		</main>
		<section class="panel capture-panel">
			<div class="stack-header"><div><p class="panel-kicker">Capture state</p><h3>Stable summary for browser capture and manual inspection</h3></div>${statusPill(state.payload ? 'completed' : 'idle')}</div>
			<pre id="capture-json" class="capture-json" data-testid="capture-summary-json"></pre>
			<script id="analysis-summary" type="application/json"></script>
		</section>
	</div>`;

	syncCapture();
	refreshContextCache();
	persist();
	window.requestAnimationFrame(function () {
		currentHostApi().notifySize(document.body.scrollHeight);
	});
}

async function runTool(name, args, nextTab) {
	const host = currentHostApi();
	if (!host.canCallTools()) {
		state.error = 'Live MCP calls are only available inside a connected host bridge.';
		render();
		return;
	}
	state.error = '';
	state.message = `Running ${name}...`;
	render();
	try {
		const result = await host.callTool(name, args);
		const payload = extractStructuredResult(result);
		if (!payload) throw new Error(`${name} returned no structured content`);
		state.payload = payload;
		state.toolInput = args || {};
		state.message = `${name} completed successfully.`;
		if (nextTab) state.tab = nextTab;
		const currentJobId = deriveJobId(payload);
		if (currentJobId) state.selectedJobId = currentJobId;
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
	}
	render();
}

async function prepareApprovalBundle() {
	const repoKey = currentRepoKey(state.payload);
	const blocker = blockingState(state.payload);
	const summary = runSummary(state.payload);
	const jobId = deriveJobId(state.payload);
	if (!repoKey || !jobId) return;
	await runTool(
		'request_permission_bundle',
		{
			repos: [repoKey],
			preset: approvalPresetForAction(blocker && blocker.blocked_action ? blocker.blocked_action : ''),
			reason:
				(blocker && blocker.reason) ||
				(summary && summary.approval_reason) ||
				'Need approval to continue the current notification workflow.',
			job_id: jobId,
			blocked_action: blocker && blocker.blocked_action ? blocker.blocked_action : undefined,
		},
		'overview',
	);
}

async function buildIncidentBundle() {
	const repoInfo = splitRepoKey(currentRepoKey(state.payload));
	if (!repoInfo) return;
	const jobId = deriveJobId(state.payload);
	await runTool(
		'incident_bundle_create',
		{
			owner: repoInfo.owner,
			repo: repoInfo.repo,
			job_id: jobId || undefined,
			scope: jobId ? 'job' : 'all_active',
			include_layer_logs: true,
		},
		'incident',
	);
}

async function askAssistant() {
	const host = currentHostApi();
	if (!host.canSendMessage()) {
		state.error = 'Host follow-up messaging is unavailable in this environment.';
		render();
		return;
	}
	const snapshot = buildModelContextSnapshot();
	const jobId = snapshot.job_id ? ` for ${snapshot.job_id}` : '';
	const blocker = snapshot.blocking_state;
	const prompt =
		blocker && blocker.kind && blocker.kind !== 'none'
			? `Summarize the current blocker${jobId} and recommend the next operator action.`
			: `Summarize the current notification state${jobId} and recommend the next operator action.`;
	state.error = '';
	state.message = 'Sending follow-up message to the host...';
	render();
	try {
		await host.updateModelContext(snapshot);
		await host.sendMessage(prompt);
		state.message = 'Follow-up message sent to the host.';
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
	}
	render();
}

function openFullPage() {
	currentHostApi()
		.openLink(`${config.appOrigin}/gui/`)
		.catch(function (error) {
			console.warn(error);
		});
}

function hydrate() {
	restoreViewState();
	if (state.hostContext) {
		applyHostContextToDocument(state.hostContext, document);
	}
	state.toolInput = hostToolInput();
	const payload = hostToolOutput();
	if (payload) {
		state.payload = payload;
		state.message = 'Host bridge connected.';
	} else {
		state.payload = demoPayload;
		state.message = 'Showing standalone preview data.';
		if (!state.selectedJobId) {
			state.tab = 'jobs';
		}
	}
	if (!state.selectedJobId) state.selectedJobId = deriveJobId(state.payload);
	currentHostApi().setOpenInAppUrl();
	refreshContextCache();
	render();
}

async function connectStandardBridge() {
	if (window.parent === window || state.mcpBridge) return;
	const bridge = createMcpUiBridge({
		win: window,
		doc: document,
		appInfo: APP_INFO,
		appCapabilities: {
			availableDisplayModes: ['inline', 'fullscreen'],
		},
		onHostContextChanged(hostContext, result) {
			state.hostContext = hostContext;
			state.hostCapabilities = hasRecord(result) && hasRecord(result.hostCapabilities) ? result.hostCapabilities : state.hostCapabilities;
			applyHostContextToDocument(hostContext, document);
			render();
		},
		onToolInput(params) {
			state.toolInput = hasRecord(params) && hasRecord(params.arguments) ? params.arguments : {};
			if (!state.selectedJobId && typeof state.toolInput.job_id === 'string') {
				state.selectedJobId = state.toolInput.job_id;
			}
			render();
		},
		onToolResult(params) {
			const payload = extractStructuredResult(params);
			if (!payload) return;
			state.payload = payload;
			const currentJobId = deriveJobId(payload);
			if (currentJobId) {
				state.selectedJobId = currentJobId;
			}
			state.message = 'Host pushed fresh tool output.';
			state.error = '';
			render();
		},
		onToolCancelled() {
			state.error = 'Host cancelled the current tool execution.';
			state.message = '';
			render();
		},
		onRequestTeardown() {
			state.message = 'Host requested widget teardown.';
			render();
		},
	});
	state.mcpBridge = bridge;
	try {
		const bridgeState = await bridge.connect();
		state.hostContext = bridgeState.hostContext;
		state.hostCapabilities = bridgeState.hostCapabilities;
		applyHostContextToDocument(state.hostContext, document);
		hydrate();
	} catch (error) {
		if (!openaiBridge()) {
			console.warn(error);
		}
	}
}

root.addEventListener('click', function (event) {
	const actionTarget = event.target.closest('[data-action]');
	if (!actionTarget) return;
	const action = actionTarget.getAttribute('data-action');
	if (action === 'set-tab') {
		state.tab = actionTarget.getAttribute('data-tab') || 'overview';
		render();
		return;
	}
	if (action === 'load-jobs') {
		runTool('jobs_list', {}, 'jobs');
		return;
	}
	if (action === 'refresh-current') {
		const currentJobId = deriveJobId(state.payload);
		if (currentJobId) runTool('job_progress', { job_id: currentJobId }, 'overview');
		return;
	}
	if (action === 'load-feed') {
		const currentJobId = deriveJobId(state.payload);
		if (currentJobId) {
			runTool(
				'job_event_feed',
				{
					job_id: currentJobId,
					status: state.feedFilters.status || undefined,
					source_layer: state.feedFilters.sourceLayer || undefined,
					limit: state.feedFilters.limit,
				},
				'events',
			);
		}
		return;
	}
	if (action === 'open-job') {
		const jobId = actionTarget.getAttribute('data-job-id') || '';
		if (!jobId) return;
		state.selectedJobId = jobId;
		runTool('job_progress', { job_id: jobId }, 'overview');
		return;
	}
	if (action === 'prepare-approval') {
		prepareApprovalBundle();
		return;
	}
	if (action === 'build-incident') {
		buildIncidentBundle();
		return;
	}
	if (action === 'ask-assistant') {
		askAssistant();
		return;
	}
	if (action === 'open-full-page') {
		openFullPage();
	}
});

root.addEventListener('submit', function (event) {
	const form = event.target;
	if (!(form instanceof HTMLFormElement) || form.getAttribute('data-form') !== 'feed-filters') return;
	event.preventDefault();
	const formData = new FormData(form);
	state.feedFilters = {
		status: String(formData.get('status') || ''),
		sourceLayer: String(formData.get('sourceLayer') || ''),
		limit: Math.max(1, Math.min(200, Number(formData.get('limit')) || 50)),
	};
	const currentJobId = deriveJobId(state.payload);
	if (currentJobId) {
		runTool(
			'job_event_feed',
			{
				job_id: currentJobId,
				status: state.feedFilters.status || undefined,
				source_layer: state.feedFilters.sourceLayer || undefined,
				limit: state.feedFilters.limit,
			},
			'events',
		);
	}
});

window.addEventListener('openai:set_globals', function () {
	hydrate();
});

hydrate();
void connectStandardBridge();
