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
	chatUiUrl: 'https://chatgpt.com/',
};

const APP_INFO = {
	name: 'opengpt-run-console',
	title: 'OpenGPT Run Console',
	version: '2.0.0',
	websiteUrl: `${config.appOrigin}/gui/`,
};

const VIEW_STATE_STORAGE_KEY = 'opengpt.run-console.view';
const STANDALONE_TOKEN_STORAGE_KEY = 'opengpt.run-console.token';
const STANDALONE_AUTH_STATE_STORAGE_KEY = 'opengpt.run-console.auth.pending';
const ATTENTION_STATUSES = ['idle', 'pending_approval', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed'];
const SOURCE_LAYERS = ['gpt', 'mcp', 'cloudflare', 'repo', 'system'];
const POLL_INTERVAL_MS = 20000;
const DASHBOARD_SORTS = ['recent', 'status', 'name'];
const DETAIL_SECTIONS = ['logs', 'inputs', 'info', 'future'];

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
	focusSection: 'logs',
	approvalNote: '',
	controlNote: '',
	chatDraft: '',
	futureInstructions: '',
	futureInstructionsDraft: '',
	futureInstructionsSavedAt: '',
	feedFilters: {
		status: '',
		sourceLayer: '',
		limit: 50,
	},
	dashboardSearch: '',
	dashboardStatus: 'all',
	dashboardSort: 'recent',
	message: '',
	error: '',
	bridge: null,
	lastPayloadKind: '',
	localSessionCounter: 1,
	lastModelContextKey: '',
	hostStatusAutoloaded: false,
	notificationMenuOpen: false,
	utilityMenuOpen: false,
	seenAlertKeys: {},
	dismissedAlertKeys: {},
	dismissedNotificationIds: {},
	session: {
		ready: false,
		email: null,
		authType: null,
		error: '',
	},
	auth: {
		ready: false,
		enabled: false,
		loading: false,
		error: '',
		issuer: null,
		clientId: null,
		audience: null,
		scope: 'openid profile email',
		redirectUri: null,
		authorizationUrl: null,
		tokenUrl: null,
		logoutUrl: null,
		missing: [],
	},
	standaloneToken: '',
	pollTimer: null,
	pollInFlight: false,
	modelContextTimer: null,
	alertSignatures: {},
	alertBaselineReady: false,
	alertPermissionRequested: false,
	alertPermissionState: browserAlertsSupported() ? window.Notification.permission : 'unsupported',
};

function createStore() {
	return {
		jobs: {},
		browserControl: null,
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
		targetPaths: [],
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
		browserControl: null,
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

function currentRouteJobId() {
	const params = new URLSearchParams(window.location.search);
	const jobId = params.get('job');
	return typeof jobId === 'string' && jobId.trim() ? jobId.trim() : '';
}

function currentPage() {
	return currentRouteJobId() ? 'detail' : 'list';
}

function normalizeDetailSection(value) {
	if (DETAIL_SECTIONS.includes(value)) {
		return value;
	}
	if (value === 'activity') return 'logs';
	if (value === 'approval' || value === 'control' || value === 'overview' || value === 'chat') return 'info';
	return 'logs';
}

function syncRouteStateFromLocation() {
	const jobId = currentRouteJobId();
	const params = new URLSearchParams(window.location.search);
	const tab = params.get('tab');
	if (jobId) {
		state.selectedJobId = jobId;
	}
	state.focusSection = normalizeDetailSection(tab);
}

function navigateToList() {
	const nextUrl = new URL(window.location.href);
	nextUrl.searchParams.delete('job');
	nextUrl.searchParams.delete('tab');
	window.history.pushState({}, '', nextUrl);
	state.selectedJobId = '';
	state.selectedNotificationId = '';
	state.selectedLogId = '';
	render();
}

function navigateToJob(jobId, nextSection = state.focusSection) {
	if (!jobId) return;
	const detailSection = normalizeDetailSection(nextSection);
	const nextUrl = new URL(window.location.href);
	nextUrl.searchParams.set('job', jobId);
	nextUrl.searchParams.set('tab', detailSection);
	window.history.pushState({}, '', nextUrl);
	state.selectedJobId = jobId;
	state.focusSection = detailSection;
	render();
}

function restoreStandaloneToken() {
	try {
		state.standaloneToken = window.localStorage.getItem(STANDALONE_TOKEN_STORAGE_KEY) || '';
	} catch (error) {
		console.warn(error);
	}
}

function persistStandaloneToken() {
	try {
		if (state.standaloneToken.trim()) {
			window.localStorage.setItem(STANDALONE_TOKEN_STORAGE_KEY, state.standaloneToken.trim());
			return;
		}
		window.localStorage.removeItem(STANDALONE_TOKEN_STORAGE_KEY);
	} catch (error) {
		console.warn(error);
	}
}

function readPendingStandaloneAuth() {
	try {
		const raw = window.sessionStorage.getItem(STANDALONE_AUTH_STATE_STORAGE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw);
		if (!hasRecord(parsed)) {
			return null;
		}
		return {
			state: typeof parsed.state === 'string' ? parsed.state : '',
			codeVerifier: typeof parsed.codeVerifier === 'string' ? parsed.codeVerifier : '',
			redirectUri: typeof parsed.redirectUri === 'string' ? parsed.redirectUri : '',
			returnTo: typeof parsed.returnTo === 'string' ? parsed.returnTo : '',
		};
	} catch (error) {
		console.warn(error);
		return null;
	}
}

function writePendingStandaloneAuth(value) {
	try {
		window.sessionStorage.setItem(STANDALONE_AUTH_STATE_STORAGE_KEY, JSON.stringify(value));
	} catch (error) {
		console.warn(error);
	}
}

function clearPendingStandaloneAuth() {
	try {
		window.sessionStorage.removeItem(STANDALONE_AUTH_STATE_STORAGE_KEY);
	} catch (error) {
		console.warn(error);
	}
}

function base64UrlEncodeBytes(bytes) {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createRandomBase64Url(byteLength) {
	const bytes = new Uint8Array(byteLength);
	window.crypto.getRandomValues(bytes);
	return base64UrlEncodeBytes(bytes);
}

async function sha256Base64Url(value) {
	const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function parseJsonResponse(response) {
	const contentType = response.headers.get('content-type') || '';
	if (contentType.includes('application/json')) {
		return response.json();
	}
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return { error: text };
	}
}

async function refreshStandaloneAuthConfig(options = {}) {
	if (window.parent && window.parent !== window) {
		return;
	}
	state.auth.loading = true;
	if (!options.skipRender) {
		render();
	}
	try {
		const response = await fetch(`${config.appOrigin}/gui/api/auth/config`, {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		});
		const payload = await parseJsonResponse(response);
		if (!response.ok || payload.ok === false || !payload.data || !hasRecord(payload.data.auth)) {
			throw new Error(
				payload && typeof payload.error === 'string'
					? payload.error
					: `${response.status} ${response.statusText}`.trim(),
			);
		}
		const auth = payload.data.auth;
		state.auth.ready = true;
		state.auth.enabled = auth.enabled === true;
		state.auth.error = '';
		state.auth.issuer = typeof auth.issuer === 'string' ? auth.issuer : null;
		state.auth.clientId = typeof auth.client_id === 'string' ? auth.client_id : null;
		state.auth.audience = typeof auth.audience === 'string' ? auth.audience : null;
		state.auth.scope = typeof auth.scope === 'string' && auth.scope.trim() ? auth.scope : 'openid profile email';
		state.auth.redirectUri = typeof auth.redirect_uri === 'string' ? auth.redirect_uri : null;
		state.auth.authorizationUrl = typeof auth.authorization_url === 'string' ? auth.authorization_url : null;
		state.auth.tokenUrl = typeof auth.token_url === 'string' ? auth.token_url : null;
		state.auth.logoutUrl = typeof auth.logout_url === 'string' ? auth.logout_url : null;
		state.auth.missing = Array.isArray(auth.missing) ? auth.missing.filter((item) => typeof item === 'string') : [];
	} catch (error) {
		state.auth.ready = false;
		state.auth.enabled = false;
		state.auth.error = error instanceof Error ? error.message : String(error);
		state.auth.issuer = null;
		state.auth.clientId = null;
		state.auth.audience = null;
		state.auth.scope = 'openid profile email';
		state.auth.redirectUri = null;
		state.auth.authorizationUrl = null;
		state.auth.tokenUrl = null;
		state.auth.logoutUrl = null;
		state.auth.missing = [];
	} finally {
		state.auth.loading = false;
		if (!options.skipRender) {
			render();
		}
	}
}

function cleanupStandaloneAuthQuery(returnTo = '') {
	const nextUrl = returnTo ? new URL(returnTo, window.location.origin) : new URL(window.location.href);
	nextUrl.searchParams.delete('code');
	nextUrl.searchParams.delete('state');
	nextUrl.searchParams.delete('error');
	nextUrl.searchParams.delete('error_description');
	window.history.replaceState({}, '', nextUrl);
	syncRouteStateFromLocation();
}

async function completeStandaloneBrowserLogin(options = {}) {
	if (window.parent && window.parent !== window) {
		return false;
	}
	const url = new URL(window.location.href);
	const authError = url.searchParams.get('error');
	const authErrorDescription = url.searchParams.get('error_description');
	const authCode = url.searchParams.get('code');
	const authState = url.searchParams.get('state');
	if (!authError && !authCode) {
		return false;
	}
	if (authError) {
		clearPendingStandaloneAuth();
		cleanupStandaloneAuthQuery();
		state.error = authErrorDescription ? `${authError}: ${authErrorDescription}` : authError;
		state.message = '';
		if (!options.skipRender) {
			render();
		}
		return true;
	}
	const pending = readPendingStandaloneAuth();
	if (!pending || !pending.state || !pending.codeVerifier || !pending.redirectUri) {
		cleanupStandaloneAuthQuery();
		state.error = 'The browser login flow could not be resumed because the PKCE session is missing.';
		state.message = '';
		if (!options.skipRender) {
			render();
		}
		return true;
	}
	if (pending.state !== authState) {
		clearPendingStandaloneAuth();
		cleanupStandaloneAuthQuery();
		state.error = 'The browser login callback state does not match the pending request.';
		state.message = '';
		if (!options.skipRender) {
			render();
		}
		return true;
	}
	if (!state.auth.ready) {
		await refreshStandaloneAuthConfig({ skipRender: true });
	}
	if (!state.auth.enabled || !state.auth.clientId || !state.auth.tokenUrl) {
		clearPendingStandaloneAuth();
		cleanupStandaloneAuthQuery();
		state.error = state.auth.error || 'Browser login is not configured for this GUI.';
		state.message = '';
		if (!options.skipRender) {
			render();
		}
		return true;
	}
	try {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: state.auth.clientId,
			code: authCode,
			code_verifier: pending.codeVerifier,
			redirect_uri: pending.redirectUri,
		});
		const response = await fetch(state.auth.tokenUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: body.toString(),
		});
		const payload = await parseJsonResponse(response);
		if (!response.ok) {
			throw new Error(
				payload && typeof payload.error_description === 'string'
					? payload.error_description
					: payload && typeof payload.error === 'string'
						? payload.error
						: `${response.status} ${response.statusText}`.trim(),
			);
		}
		if (!payload || typeof payload.access_token !== 'string' || !payload.access_token.trim()) {
			throw new Error('The token response did not include an access_token.');
		}
		state.standaloneToken = payload.access_token.trim();
		persistStandaloneToken();
		clearPendingStandaloneAuth();
		cleanupStandaloneAuthQuery(pending.returnTo);
		state.message = 'Signed in with Auth0 for the standalone web control API.';
		state.error = '';
		if (!options.skipRender) {
			render();
		}
		return true;
	} catch (error) {
		clearPendingStandaloneAuth();
		cleanupStandaloneAuthQuery(pending.returnTo);
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
		if (!options.skipRender) {
			render();
		}
		return true;
	}
}

async function beginStandaloneBrowserLogin() {
	if (window.parent && window.parent !== window) {
		return;
	}
	if (!state.auth.ready) {
		await refreshStandaloneAuthConfig({ skipRender: true });
	}
	if (!state.auth.enabled || !state.auth.clientId || !state.auth.authorizationUrl || !state.auth.redirectUri) {
		state.error =
			state.auth.error ||
			(state.auth.missing.length
				? `Browser login is unavailable until ${state.auth.missing.join(', ')} is configured.`
				: 'Browser login is unavailable for this GUI.');
		state.message = '';
		render();
		return;
	}
	const codeVerifier = createRandomBase64Url(48);
	const loginState = createRandomBase64Url(24);
	const codeChallenge = await sha256Base64Url(codeVerifier);
	writePendingStandaloneAuth({
		state: loginState,
		codeVerifier,
		redirectUri: state.auth.redirectUri,
		returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
	});
	const authorizeUrl = new URL(state.auth.authorizationUrl);
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('client_id', state.auth.clientId);
	authorizeUrl.searchParams.set('redirect_uri', state.auth.redirectUri);
	authorizeUrl.searchParams.set('scope', state.auth.scope || 'openid profile email');
	if (state.auth.audience) {
		authorizeUrl.searchParams.set('audience', state.auth.audience);
	}
	authorizeUrl.searchParams.set('state', loginState);
	authorizeUrl.searchParams.set('code_challenge', codeChallenge);
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');
	window.location.assign(authorizeUrl.toString());
}

async function disconnectStandaloneBrowserLogin() {
	state.standaloneToken = '';
	persistStandaloneToken();
	clearPendingStandaloneAuth();
	state.session.ready = false;
	state.session.email = null;
	state.session.authType = null;
	state.session.error = '';
	state.store.browserControl = null;
	state.message = 'Stored bearer token cleared from this browser.';
	state.error = '';
	stopPolling();
	await refreshStandaloneSession();
	if (state.session.ready) {
		startPolling();
		void loadJobs({ silent: true, keepSection: true });
	}
}

async function apiRequest(path, options = {}) {
	const headers = new Headers(options.headers || {});
	headers.set('accept', 'application/json');
	if (options.body != null && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	if (state.standaloneToken.trim()) {
		headers.set('authorization', `Bearer ${state.standaloneToken.trim()}`);
	}
	const response = await fetch(`${config.appOrigin}${path}`, {
		method: options.method || 'GET',
		headers,
		body: options.body != null ? JSON.stringify(options.body) : undefined,
		credentials: 'same-origin',
	});
	const contentType = response.headers.get('content-type') || '';
	const payload = contentType.includes('application/json')
		? await response.json()
		: {
			ok: response.ok,
			error: await response.text(),
		};
	if (!response.ok || payload.ok === false) {
		const message = payload && typeof payload.error === 'string'
			? payload.error
			: `${response.status} ${response.statusText}`.trim();
		const error = new Error(message);
		error.status = response.status;
		throw error;
	}
	return payload;
}

function asToolEnvelope(structuredContent) {
	return {
		structuredContent,
		meta: null,
	};
}

async function standaloneCallTool(name, args = {}) {
	switch (name) {
		case 'jobs_list': {
			const params = new URLSearchParams();
			if (typeof args.status === 'string' && args.status) params.set('status', args.status);
			if (typeof args.next_actor === 'string' && args.next_actor) params.set('next_actor', args.next_actor);
			const payload = await apiRequest(`/gui/api/jobs${params.toString() ? `?${params}` : ''}`);
			return asToolEnvelope({
				kind: 'opengpt.notification_contract.jobs_list',
				jobs: payload.data && Array.isArray(payload.data.jobs) ? payload.data.jobs : [],
			});
		}
		case 'job_progress': {
			if (typeof args.job_id !== 'string' || !args.job_id) {
				throw new Error('job_progress requires job_id');
			}
			const payload = await apiRequest(`/gui/api/jobs/${encodeURIComponent(args.job_id)}`);
			const progress = payload.data && hasRecord(payload.data.progress) ? payload.data.progress : {};
			return asToolEnvelope({
				kind: 'opengpt.notification_contract.job_progress',
				progress,
				run_summary: progress.run_summary || null,
				blocking_state: progress.blocking_state || null,
				latest_notification: progress.latest_notification || null,
				notification_counts: progress.notification_counts || createEmptyCounts(),
				browser_control: progress.browser_control || null,
			});
		}
		case 'job_event_feed': {
			if (typeof args.job_id !== 'string' || !args.job_id) {
				throw new Error('job_event_feed requires job_id');
			}
			const params = new URLSearchParams();
			if (typeof args.status === 'string' && args.status) params.set('status', args.status);
			if (typeof args.source_layer === 'string' && args.source_layer) params.set('source_layer', args.source_layer);
			if (typeof args.since === 'string' && args.since) params.set('since', args.since);
			if (Number.isFinite(Number(args.limit))) params.set('limit', String(Number(args.limit)));
			const payload = await apiRequest(`/gui/api/jobs/${encodeURIComponent(args.job_id)}/feed?${params.toString()}`);
			return asToolEnvelope({
				kind: 'opengpt.notification_contract.job_event_feed',
				items: payload.data && Array.isArray(payload.data.items) ? payload.data.items : [],
				logs: payload.data && Array.isArray(payload.data.logs) ? payload.data.logs : [],
				counts: payload.data && hasRecord(payload.data.counts) ? payload.data.counts : createEmptyCounts(),
			});
		}
		case 'job_control': {
			if (typeof args.job_id !== 'string' || !args.job_id) {
				throw new Error('job_control requires job_id');
			}
			const payload = await apiRequest(`/gui/api/jobs/${encodeURIComponent(args.job_id)}/control`, {
				method: 'POST',
				body: {
					action: args.action,
					reason: args.reason,
					expected_state: args.expected_state,
					resume_strategy: args.resume_strategy,
				},
			});
			const progress = payload.data && hasRecord(payload.data.progress) ? payload.data.progress : {};
			return asToolEnvelope({
				kind: 'opengpt.notification_contract.job_progress',
				action: payload.data ? payload.data.action : null,
				progress,
				run_summary: progress.run_summary || null,
				blocking_state: progress.blocking_state || null,
				latest_notification: progress.latest_notification || null,
				notification_counts: progress.notification_counts || createEmptyCounts(),
				resume_strategy: payload.data ? payload.data.resume_strategy : null,
				workflow_cancel: payload.data ? payload.data.workflow_cancel || null : null,
			});
		}
		case 'permission_request_resolve': {
			if (typeof args.job_id !== 'string' || !args.job_id) {
				throw new Error('permission_request_resolve requires job_id');
			}
			const payload = await apiRequest(`/gui/api/jobs/${encodeURIComponent(args.job_id)}/approval/resolve`, {
				method: 'POST',
				body: {
					request_id: args.request_id,
					resolution: args.resolution,
					note: args.note,
				},
			});
			return asToolEnvelope({
				kind: 'opengpt.notification_contract.permission_bundle',
				request_id: payload.data ? payload.data.request_id ?? null : null,
				status: payload.data ? payload.data.status ?? null : null,
				requested_at: payload.data ? payload.data.requested_at ?? null : null,
				resolved_at: payload.data ? payload.data.resolved_at ?? null : null,
				bundle: payload.data ? payload.data.bundle ?? null : null,
				notification: payload.data ? payload.data.notification ?? null : null,
				current_progress: payload.data ? payload.data.current_progress ?? null : null,
			});
		}
		default:
			throw new Error(`${name} is unavailable from the standalone web control API.`);
	}
}

function browserAlertsSupported() {
	return typeof window.Notification === 'function';
}

function currentBrowserAlertPermission() {
	return browserAlertsSupported() ? window.Notification.permission : 'unsupported';
}

async function requestBrowserAlertsPermission() {
	if (!browserAlertsSupported()) {
		throw new Error('Browser notifications are unavailable in this environment.');
	}
	const permission = await window.Notification.requestPermission();
	syncBrowserAlertPermissionState(sortedJobs());
	return permission;
}

function browserAlertDetail(job, attention = jobAttentionStatus(job)) {
	if (!job) {
		return { title: 'Run update', body: 'The run state changed.' };
	}
	const notification = job.latestNotification;
	const interrupt = currentInterrupt(job);
	const title = job.run && job.run.title ? job.run.title : job.jobId;
	if (attention === 'pending_approval') {
		return {
			title,
			body:
				notification?.body ||
				job.blockingState?.reason ||
				job.run?.approvalReason ||
				'Approval is required before the run can continue.',
		};
	}
	if (attention === 'interrupted') {
		return {
			title,
			body:
				notification?.body ||
				interrupt?.message ||
				job.blockingState?.reason ||
				job.run?.lastEvent ||
				'The run was interrupted and needs attention.',
		};
	}
	if (attention === 'failed') {
		return {
			title,
			body: notification?.body || job.blockingState?.reason || job.run?.lastEvent || 'The run failed and needs attention.',
		};
	}
	if (attention === 'completed') {
		return {
			title,
			body: notification?.body || job.run?.lastEvent || 'The run completed successfully.',
		};
	}
	return {
		title,
		body: notification?.body || job.run?.lastEvent || 'The run state changed.',
	};
}

function jobAlertSignature(job) {
	if (!job) return '';
	const attention = jobAttentionStatus(job);
	const latestCursor =
		(job.latestNotification && job.latestNotification.id) ||
		(job.latestNotification && job.latestNotification.createdAt) ||
		(job.run && job.run.updatedAt) ||
		job.updatedAt ||
		'none';
	return `${attention}:${latestCursor}`;
}

function captureJobAlertSignatures(jobs) {
	const nextSignatures = {};
	for (const job of jobs) {
		nextSignatures[job.jobId] = jobAlertSignature(job);
	}
	return nextSignatures;
}

function emitBrowserAlert(job, attention = jobAttentionStatus(job)) {
	if (!job || !browserAlertsSupported() || currentBrowserAlertPermission() !== 'granted') {
		return false;
	}
	const detail = browserAlertDetail(job, attention);
	try {
		new window.Notification(detail.title, {
			body: `[${statusLabel(attention)}] ${detail.body}`,
			tag: `job-alert-${job.jobId}`,
		});
		return true;
	} catch (error) {
		console.warn(error);
		return false;
	}
}

function syncBrowserAlertPermissionState(jobs = sortedJobs(), nextSignatures = captureJobAlertSignatures(jobs)) {
	const permission = currentBrowserAlertPermission();
	const previous = state.alertPermissionState;
	state.alertPermissionState = permission;
	if (permission !== 'granted' || previous === 'granted') {
		return false;
	}
	const visibleJobIds = new Set(buildNotificationCenterItems().map((item) => item.jobId));
	for (const job of jobs) {
		const attention = jobAttentionStatus(job);
		if (!actionableStatus(attention) || !visibleJobIds.has(job.jobId)) {
			continue;
		}
		emitBrowserAlert(job, attention);
	}
	state.alertSignatures = nextSignatures;
	state.alertBaselineReady = Object.keys(nextSignatures).length > 0;
	return true;
}

function maybeEmitBrowserAlerts(jobs) {
	if (!Array.isArray(jobs) || !jobs.length) {
		return;
	}
	const nextSignatures = captureJobAlertSignatures(jobs);
	if (syncBrowserAlertPermissionState(jobs, nextSignatures)) {
		return;
	}
	if (!state.alertBaselineReady) {
		state.alertSignatures = nextSignatures;
		state.alertBaselineReady = true;
		return;
	}
	if (!browserAlertsSupported() || currentBrowserAlertPermission() !== 'granted') {
		state.alertSignatures = nextSignatures;
		return;
	}
	for (const job of jobs) {
		const attention = jobAttentionStatus(job);
		const previous = state.alertSignatures[job.jobId] || '';
		const current = nextSignatures[job.jobId];
		if (previous === current) {
			continue;
		}
		if (!actionableStatus(attention)) {
			continue;
		}
		emitBrowserAlert(job, attention);
	}
	state.alertSignatures = nextSignatures;
}

function primeBrowserAlertsBaseline(jobs = sortedJobs()) {
	if (!Array.isArray(jobs) || !jobs.length) {
		state.alertSignatures = {};
		state.alertBaselineReady = false;
		return;
	}
	const nextSignatures = {};
	for (const job of jobs) {
		nextSignatures[job.jobId] = jobAlertSignature(job);
	}
	state.alertSignatures = nextSignatures;
	state.alertBaselineReady = true;
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

function formatRelativeTime(value) {
	if (!value) return 'Unknown';
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return String(value);
	const seconds = Math.round((date.getTime() - Date.now()) / 1000);
	const absoluteSeconds = Math.abs(seconds);
	if (absoluteSeconds < 60) {
		return seconds >= 0 ? 'Soon' : 'Just now';
	}
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	if (absoluteSeconds < 3600) {
		return formatter.format(Math.round(seconds / 60), 'minute');
	}
	if (absoluteSeconds < 86400) {
		return formatter.format(Math.round(seconds / 3600), 'hour');
	}
	return formatter.format(Math.round(seconds / 86400), 'day');
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

function statusSortOrder(status) {
	if (status === 'pending_approval') return 0;
	if (status === 'interrupted') return 1;
	if (status === 'failed') return 2;
	if (status === 'running') return 3;
	if (status === 'paused') return 4;
	if (status === 'cancelled') return 5;
	if (status === 'completed') return 6;
	return 7;
}

function matchesDashboardSearch(job, query) {
	if (!query) return true;
	const candidate = [
		job.jobId,
		job.repo,
		job.nextActor,
		job.run && job.run.title,
		job.run && job.run.lastEvent,
		job.blockingState && job.blockingState.reason,
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
	return candidate.includes(query.toLowerCase());
}

function dashboardJobs() {
	const statusFilter = state.dashboardStatus;
	const jobs = sortedJobs()
		.filter((job) => matchesDashboardSearch(job, state.dashboardSearch))
		.filter((job) => statusFilter === 'all' || jobAttentionStatus(job) === statusFilter);
	if (state.dashboardSort === 'name') {
		return jobs.sort((left, right) => {
			const leftLabel = left.run && left.run.title ? left.run.title : left.jobId;
			const rightLabel = right.run && right.run.title ? right.run.title : right.jobId;
			return leftLabel.localeCompare(rightLabel);
		});
	}
	if (state.dashboardSort === 'status') {
		return jobs.sort((left, right) => {
			const priority = statusSortOrder(jobAttentionStatus(left)) - statusSortOrder(jobAttentionStatus(right));
			if (priority !== 0) return priority;
			const leftTime = left.run?.updatedAt || left.updatedAt || '';
			const rightTime = right.run?.updatedAt || right.updatedAt || '';
			return String(rightTime).localeCompare(String(leftTime));
		});
	}
	return jobs;
}

function iconSvg(path, className, viewBox = '0 0 24 24') {
	return `<svg class="${className}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}" /></svg>`;
}

function bellIcon(className = 'icon') {
	return iconSvg('M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 0 1-6 0m6 0H9', className);
}

function searchIcon(className = 'icon') {
	return iconSvg('m21 21-4.3-4.3M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', className);
}

function closeIcon(className = 'icon') {
	return iconSvg('M18 6 6 18M6 6l12 12', className);
}

function refreshIcon(className = 'icon') {
	return iconSvg('M21 12a9 9 0 0 1-15.5 6.4M3 12A9 9 0 0 1 18.5 5.6M21 3v6h-6M3 21v-6h6', className);
}

function clockIcon(className = 'icon') {
	return iconSvg('M12 7v5l3 3M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z', className);
}

function runIcon(className = 'icon') {
	return `<svg class="${className}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7Z"></path></svg>`;
}

function actionableStatus(status) {
	return status === 'pending_approval' || status === 'interrupted' || status === 'failed' || status === 'completed';
}

function buildNotificationCenterItems() {
	const items = [];
	for (const job of sortedJobs()) {
		const attention = jobAttentionStatus(job);
		if (!actionableStatus(attention)) {
			continue;
		}
		const notification = job.latestNotification;
		const interrupt = currentInterrupt(job);
		const approval = job.approval;
		let title = notification && notification.title ? notification.title : job.run?.title || job.jobId;
		let body = notification && notification.body ? notification.body : job.run?.lastEvent || 'Operator attention is required.';
		let createdAt = notification && notification.createdAt ? notification.createdAt : job.run?.updatedAt || '';
		let section = 'info';
		let key = `${attention}:${job.jobId}:${notification && notification.id ? notification.id : createdAt || 'state'}`;
		if (attention === 'pending_approval') {
			section = 'info';
			title = notification?.title || 'Approval requested';
			body =
				notification?.body ||
				approval?.reason ||
				job.blockingState?.reason ||
				job.run?.approvalReason ||
				job.run?.lastEvent ||
				'Approval is required before the run can continue.';
			createdAt = notification?.createdAt || approval?.requestedAt || job.run?.updatedAt || '';
			key = `approval:${job.jobId}:${notification?.id || approval?.requestId || createdAt || 'pending'}`;
		} else if (attention === 'interrupted') {
			section = 'logs';
			title = notification?.title || interrupt?.kind || 'Run interrupted';
			body =
				notification?.body ||
				interrupt?.message ||
				job.blockingState?.reason ||
				job.run?.lastEvent ||
				'The run was interrupted and may need control action.';
			createdAt = notification?.createdAt || interrupt?.recordedAt || job.run?.updatedAt || '';
			key = `interrupted:${job.jobId}:${notification?.id || interrupt?.recordedAt || createdAt || 'interrupted'}`;
		} else if (attention === 'failed') {
			section = 'info';
			title = notification?.title || 'Run failed';
			body = notification?.body || job.blockingState?.reason || job.run?.lastEvent || 'The run failed and needs operator attention.';
			createdAt = notification?.createdAt || job.run?.updatedAt || '';
			key = `failed:${job.jobId}:${notification?.id || createdAt || 'failed'}`;
		} else if (attention === 'completed') {
			section = 'info';
			title = notification?.title || 'Run completed';
			body = notification?.body || job.run?.lastEvent || 'The run completed successfully.';
			createdAt = notification?.createdAt || job.run?.updatedAt || '';
			key = `completed:${job.jobId}:${notification?.id || createdAt || 'completed'}`;
		}
		const hidden =
			Boolean(state.dismissedAlertKeys[key]) ||
			(notification && notification.id ? Boolean(state.dismissedNotificationIds[notification.id]) : false);
		if (hidden) {
			continue;
		}
		items.push({
			key,
			jobId: job.jobId,
			notificationId: notification?.id || '',
			status: attention,
			title,
			body,
			createdAt,
			repo: job.repo || '',
			runTitle: job.run?.title || job.jobId,
			section,
		});
	}
	return items.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function unreadNotificationCount() {
	return buildNotificationCenterItems().filter((item) => !state.seenAlertKeys[item.key]).length;
}

function markNotificationsSeen(items = buildNotificationCenterItems()) {
	for (const item of items) {
		state.seenAlertKeys[item.key] = true;
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

function normalizeBrowserControl(value) {
	if (!hasRecord(value)) return null;
	const activeJob = hasRecord(value.active_job)
		? {
				jobId: typeof value.active_job.job_id === 'string' ? value.active_job.job_id : null,
				jobTitle: typeof value.active_job.job_title === 'string' ? value.active_job.job_title : null,
				repo: typeof value.active_job.repo === 'string' ? value.active_job.repo : null,
				runStatus: typeof value.active_job.run_status === 'string' ? value.active_job.run_status : null,
		  }
		: null;
	const session = hasRecord(value.session)
		? {
				sessionId: typeof value.session.session_id === 'string' ? value.session.session_id : null,
				agentName: typeof value.session.agent_name === 'string' ? value.session.agent_name : null,
				mode: typeof value.session.mode === 'string' ? value.session.mode : 'chatgpt_cdp_attach',
				status: typeof value.session.status === 'string' ? value.session.status : 'disconnected',
				connectedAt: typeof value.session.connected_at === 'string' ? value.session.connected_at : null,
				lastSeenAt: typeof value.session.last_seen_at === 'string' ? value.session.last_seen_at : null,
				pageUrl: typeof value.session.page_url === 'string' ? value.session.page_url : null,
				pageTitle: typeof value.session.page_title === 'string' ? value.session.page_title : null,
				browserName: typeof value.session.browser_name === 'string' ? value.session.browser_name : null,
				cdpOrigin: typeof value.session.cdp_origin === 'string' ? value.session.cdp_origin : null,
		  }
		: null;
	const pendingCommand = hasRecord(value.pending_command)
		? {
				commandId: typeof value.pending_command.command_id === 'string' ? value.pending_command.command_id : null,
				kind: typeof value.pending_command.kind === 'string' ? value.pending_command.kind : null,
				status: typeof value.pending_command.status === 'string' ? value.pending_command.status : 'pending',
				jobId: typeof value.pending_command.job_id === 'string' ? value.pending_command.job_id : null,
				jobTitle: typeof value.pending_command.job_title === 'string' ? value.pending_command.job_title : null,
				repo: typeof value.pending_command.repo === 'string' ? value.pending_command.repo : null,
				runStatus: typeof value.pending_command.run_status === 'string' ? value.pending_command.run_status : null,
				label: typeof value.pending_command.label === 'string' ? value.pending_command.label : null,
				prompt: typeof value.pending_command.prompt === 'string' ? value.pending_command.prompt : null,
				pageUrlHint: typeof value.pending_command.page_url_hint === 'string' ? value.pending_command.page_url_hint : null,
				createdAt: typeof value.pending_command.created_at === 'string' ? value.pending_command.created_at : null,
				createdBy: typeof value.pending_command.created_by === 'string' ? value.pending_command.created_by : null,
				claimedAt: typeof value.pending_command.claimed_at === 'string' ? value.pending_command.claimed_at : null,
				claimedBy: typeof value.pending_command.claimed_by === 'string' ? value.pending_command.claimed_by : null,
		  }
		: null;
	const lastResult = hasRecord(value.last_result)
		? {
				commandId: typeof value.last_result.command_id === 'string' ? value.last_result.command_id : null,
				kind: typeof value.last_result.kind === 'string' ? value.last_result.kind : null,
				ok: value.last_result.ok === true,
				jobId: typeof value.last_result.job_id === 'string' ? value.last_result.job_id : null,
				jobTitle: typeof value.last_result.job_title === 'string' ? value.last_result.job_title : null,
				repo: typeof value.last_result.repo === 'string' ? value.last_result.repo : null,
				runStatus: typeof value.last_result.run_status === 'string' ? value.last_result.run_status : null,
				summary: typeof value.last_result.summary === 'string' ? value.last_result.summary : null,
				error: typeof value.last_result.error === 'string' ? value.last_result.error : null,
				matchedActions: Array.isArray(value.last_result.matched_actions)
					? value.last_result.matched_actions.map((item) => String(item))
					: [],
				pageUrl: typeof value.last_result.page_url === 'string' ? value.last_result.page_url : null,
				pageTitle: typeof value.last_result.page_title === 'string' ? value.last_result.page_title : null,
				completedAt: typeof value.last_result.completed_at === 'string' ? value.last_result.completed_at : null,
		  }
		: null;
	if (!activeJob && !session && !pendingCommand && !lastResult) return null;
	return {
		activeJob,
		session,
		pendingCommand,
		lastResult,
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
	if (Array.isArray(snapshot.target_paths)) {
		job.targetPaths = snapshot.target_paths.map((value) => String(value));
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
	if (hasRecord(snapshot.browser_control)) {
		job.browserControl = normalizeBrowserControl(snapshot.browser_control);
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

function isHiddenSmokeJob(job) {
	if (!job || !/^smoke-[A-Za-z0-9._-]+$/i.test(job.jobId || '')) {
		return false;
	}
	if (!Array.isArray(job.targetPaths) || job.targetPaths.length === 0) {
		return false;
	}
	return job.targetPaths.every((path) => /^notes\/smoke-[A-Za-z0-9._-]+\.txt$/i.test(String(path)));
}

function sortedJobs() {
	return Object.values(state.store.jobs)
		.filter((job) => !isHiddenSmokeJob(job))
		.sort((left, right) => {
		const leftTime = left.run?.updatedAt || left.updatedAt || '';
		const rightTime = right.run?.updatedAt || right.updatedAt || '';
		return String(rightTime).localeCompare(String(leftTime));
		});
}

function currentJob() {
	const jobs = sortedJobs();
	if (!jobs.length) return null;
	if (state.selectedJobId) {
		const selected = jobs.find((job) => job.jobId === state.selectedJobId);
		if (selected) {
			return selected;
		}
		if (currentPage() === 'detail') {
			return null;
		}
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
	if (state.session.ready) return 'Web control API';
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
		source: state.session.ready ? 'standalone-api' : 'standalone',
		canCallTools() {
			return state.session.ready;
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
				toolCalls: state.session.ready,
				message: false,
				modelContext: false,
				openLink: true,
				raw: null,
			};
		},
		callTool(name, args) {
			if (!state.session.ready) {
				return Promise.reject(new Error('Web control API is not connected. Add browser auth or reconnect the page.'));
			}
			return standaloneCallTool(name, args || {});
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

const STANDALONE_TOOL_NAMES = new Set([
	'jobs_list',
	'job_progress',
	'job_event_feed',
	'job_control',
	'permission_request_resolve',
]);

function toolAvailable(name) {
	const host = currentHostApi();
	if (!host.canCallTools()) {
		return false;
	}
	if (host.source === 'standalone-api' || host.source === 'standalone') {
		return STANDALONE_TOOL_NAMES.has(name);
	}
	return true;
}

async function refreshStandaloneSession(options = {}) {
	if (window.parent && window.parent !== window) {
		return;
	}
	try {
		const payload = await apiRequest('/gui/api/session');
		const session = payload.data && hasRecord(payload.data.session) ? payload.data.session : {};
		state.session.ready = true;
		state.session.email = typeof session.email === 'string' ? session.email : null;
		state.session.authType = typeof session.auth_type === 'string' ? session.auth_type : 'none';
		state.session.error = '';
		state.store.host.source = 'standalone-api';
		await refreshBrowserControl({ skipRender: true }).catch(() => null);
		if (!options.skipRender) {
			render();
		}
	} catch (error) {
		state.session.ready = false;
		state.session.email = null;
		state.session.authType = null;
		state.session.error = error instanceof Error ? error.message : String(error);
		state.store.host.source = openaiBridge() ? 'window.openai fallback' : 'standalone';
		state.store.browserControl = null;
		stopPolling();
		if (!options.skipRender) {
			render();
		}
	}
}

function stopPolling() {
	if (state.pollTimer) {
		window.clearInterval(state.pollTimer);
		state.pollTimer = null;
	}
}

function hasRecentInFlightToolSession(maxAgeMs = 8000) {
	const now = Date.now();
	return Object.values(state.store.toolSessions).some((session) => {
		if (session.phase !== 'pending' && session.phase !== 'waiting') {
			return false;
		}
		const timestamp = new Date(session.updatedAt || session.createdAt || 0).getTime();
		return Number.isFinite(timestamp) && now - timestamp < maxAgeMs;
	});
}

function canAutoRefresh() {
	const host = currentHostApi();
	return host.canCallTools() && toolAvailable('jobs_list');
}

async function refreshConsoleData(options = {}) {
	if (!canAutoRefresh() || state.pollInFlight) {
		return;
	}
	state.pollInFlight = true;
	try {
		await loadJobs({ ...options, silent: true, keepSection: true, skipRender: true });
		if (externalBrowserControlAvailable()) {
			await refreshBrowserControl({ ...options, skipRender: true });
		}
		if (currentPage() === 'detail' && currentJob()) {
			await refreshCurrentRun({ ...options, silent: true, keepSection: true, skipRender: true });
			await loadFeed({ ...options, silent: true, keepSection: true, skipRender: true });
		}
	} finally {
		state.pollInFlight = false;
		render();
		void syncModelContext(false).catch((error) => console.warn(error));
	}
}

function startPolling() {
	stopPolling();
	if (!canAutoRefresh()) {
		return;
	}
	const tick = () => {
		if (document.hidden || !canAutoRefresh()) {
			return;
		}
		if (hasRecentInFlightToolSession()) {
			return;
		}
		void refreshConsoleData({ keepSection: true });
	};
	void refreshConsoleData({ keepSection: true });
	state.pollTimer = window.setInterval(tick, POLL_INTERVAL_MS);
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
		future_instructions: state.futureInstructions.trim() || null,
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

function scheduleModelContextSync(force = false) {
	if (state.modelContextTimer) {
		window.clearTimeout(state.modelContextTimer);
	}
	state.modelContextTimer = window.setTimeout(() => {
		state.modelContextTimer = null;
		void syncModelContext(force).catch((error) => console.warn(error));
	}, 250);
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

async function runTool(name, args = {}, nextSection = state.focusSection, options = {}) {
	const host = currentHostApi();
	if (!toolAvailable(name)) {
		state.error =
			host.source === 'standalone-api' || host.source === 'standalone'
				? `${name} is not exposed by the standalone web control API.`
				: 'Live MCP calls are only available inside a connected host bridge.';
		render();
		return null;
	}
	state.error = '';
	if (!options.silent) {
		state.message = `Running ${name}...`;
	}
	if (!options.keepSection) {
		state.focusSection = nextSection;
	}
	if (!options.skipRender) {
		render();
	}
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
		maybeEmitBrowserAlerts(sortedJobs());
		const derivedJobId = envelope.structuredContent ? deriveJobIdFromStructured(envelope.structuredContent) : '';
		if (derivedJobId) {
			state.selectedJobId = derivedJobId;
		}
		if (!options.silent) {
			state.message = `${name} completed successfully.`;
		}
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
		if (!options.silent) {
			state.message = '';
		}
		if (!options.skipRender) {
			render();
		}
		return null;
	} finally {
		if (!options.skipRender) {
			render();
		}
	}
}

async function refreshCurrentRun(options = {}) {
	const job = currentJob();
	if (!job) return;
	await runTool('job_progress', { job_id: job.jobId }, 'info', options);
}

async function loadJobs(options = {}) {
	await runTool('jobs_list', {}, 'logs', options);
}

async function loadFeed(options = {}) {
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
		'logs',
		options,
	);
}

async function loadHostStatus() {
	await runTool('self_host_status', { include_healthz: true }, 'info');
}

async function autoloadHostStatus() {
	if (state.hostStatusAutoloaded || state.store.host.status) {
		return;
	}
	state.hostStatusAutoloaded = true;
	await loadHostStatus();
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

function currentChatDraft(job = currentJob()) {
	if (typeof state.chatDraft === 'string' && state.chatDraft.trim()) {
		return state.chatDraft;
	}
	if (!job) {
		return 'Continue the current OpenGPT run and explain the next operator action.';
	}
	const lines = [
		`Continue job ${job.jobId} for ${job.repo || 'the selected repository'}.`,
		job.run && job.run.title ? `Run title: ${job.run.title}` : '',
		job.run && job.run.lastEvent ? `Latest event: ${job.run.lastEvent}` : '',
		job.blockingState && job.blockingState.kind !== 'none'
			? `Blocking state: ${job.blockingState.kind}${job.blockingState.reason ? ` - ${job.blockingState.reason}` : ''}`
			: '',
		job.approval && job.approval.pending && job.approval.requestId
			? `Approval request: ${job.approval.requestId}`
			: '',
		state.futureInstructions.trim() ? `Future instructions: ${state.futureInstructions.trim()}` : '',
		'Next step:',
	];
	return lines.filter(Boolean).join('\n');
}

async function copyChatDraft() {
	const text = currentChatDraft();
	if (!text.trim()) {
		state.error = 'No chat draft is available for the selected run.';
		render();
		return;
	}
	try {
		if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
			throw new Error('Clipboard API unavailable');
		}
		await navigator.clipboard.writeText(text);
		state.error = '';
		state.message = 'Chat prompt copied to the clipboard.';
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
	}
	render();
}

function openChatUi() {
	const targetUrl = typeof config.chatUiUrl === 'string' && config.chatUiUrl ? config.chatUiUrl : 'https://chatgpt.com/';
	currentHostApi()
		.openLink(targetUrl)
		.catch((error) => console.warn(error));
}

async function sendChatDraft() {
	const host = currentHostApi();
	const text = currentChatDraft();
	if (host.canSendMessage()) {
		state.error = '';
		state.message = 'Sending the draft to the host conversation...';
		render();
		try {
			await syncModelContext(true);
			await host.sendMessage(text);
			state.message = 'The draft was sent to the host conversation.';
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			state.message = '';
		}
		render();
		return;
	}
	let copied = false;
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(text);
			copied = true;
		}
	} catch (error) {
		console.warn(error);
	}
	openChatUi();
	state.error = '';
	state.message = copied
		? 'The prompt was copied and ChatGPT was opened in a new tab. Paste the draft into the conversation.'
		: 'ChatGPT was opened in a new tab. Copy the draft manually if the clipboard permission was denied.';
	render();
}

async function runAttentionShortcut(jobId = currentJob()?.jobId || '') {
	if (!jobId) return;
	state.selectedJobId = jobId;
	const job = ensureJob(jobId);
	if (!job) return;
	await refreshCurrentRun({ silent: true, keepSection: true });
	const refreshed = currentJob();
	if (!refreshed) return;
	if (refreshed.approval && refreshed.approval.pending && refreshed.approval.requestId) {
		await runTool(
			'permission_request_resolve',
			{
				job_id: refreshed.jobId,
				request_id: refreshed.approval.requestId,
				resolution: 'approved',
				note: state.approvalNote.trim() || undefined,
			},
			'approval',
			{ silent: true, keepSection: true },
		);
	}
	const afterApproval = currentJob();
	if (!afterApproval || !afterApproval.run) {
		return;
	}
	const attention = jobAttentionStatus(afterApproval);
	const controlState =
		afterApproval.control && afterApproval.control.state ? afterApproval.control.state : afterApproval.run.controlState || 'active';
	if (controlState === 'paused' || attention === 'pending_approval') {
		await performControl('resume');
		return;
	}
	if (attention === 'interrupted' || attention === 'failed') {
		await performControl('retry');
		return;
	}
	state.message = 'The selected run does not currently need a retry or approval shortcut.';
	render();
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
		if (typeof saved.focusSection === 'string') state.focusSection = normalizeDetailSection(saved.focusSection);
		if (typeof saved.approvalNote === 'string') state.approvalNote = saved.approvalNote;
		if (typeof saved.controlNote === 'string') state.controlNote = saved.controlNote;
		if (typeof saved.chatDraft === 'string') state.chatDraft = saved.chatDraft;
		if (typeof saved.futureInstructions === 'string') state.futureInstructions = saved.futureInstructions;
		if (typeof saved.futureInstructionsDraft === 'string') {
			state.futureInstructionsDraft = saved.futureInstructionsDraft;
		} else {
			state.futureInstructionsDraft = state.futureInstructions;
		}
		if (typeof saved.futureInstructionsSavedAt === 'string') state.futureInstructionsSavedAt = saved.futureInstructionsSavedAt;
		if (typeof saved.dashboardSearch === 'string') state.dashboardSearch = saved.dashboardSearch;
		if (typeof saved.dashboardStatus === 'string') state.dashboardStatus = saved.dashboardStatus;
		if (typeof saved.dashboardSort === 'string' && DASHBOARD_SORTS.includes(saved.dashboardSort)) state.dashboardSort = saved.dashboardSort;
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
				chatDraft: state.chatDraft,
				futureInstructions: state.futureInstructions,
				futureInstructionsDraft: state.futureInstructionsDraft,
				futureInstructionsSavedAt: state.futureInstructionsSavedAt,
				dashboardSearch: state.dashboardSearch,
				dashboardStatus: state.dashboardStatus,
				dashboardSort: state.dashboardSort,
				feedFilters: state.feedFilters,
			}),
		);
	} catch (error) {
		console.warn(error);
	}
}

function syncCapture() {
	const job = currentRouteJobId() ? currentJob() : null;
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

function futureInstructionsDirty() {
	return state.futureInstructionsDraft !== state.futureInstructions;
}

function futureInstructionsStatus() {
	if (futureInstructionsDirty()) {
		return {
			tone: 'pending',
			label: 'Unsaved',
			description: 'Draft changes are not yet reflected in GPT context.',
		};
	}
	if (state.futureInstructions.trim()) {
		return {
			tone: 'completed',
			label: 'Saved',
			description: state.futureInstructionsSavedAt
				? `Saved ${formatRelativeTime(state.futureInstructionsSavedAt)}`
				: 'Saved to GPT context.',
		};
	}
	return {
		tone: 'idle',
		label: 'Empty',
		description: 'No future instructions have been saved yet.',
	};
}

function syncFutureDraftUi() {
	const status = futureInstructionsStatus();
	const statusPill = root.querySelector('[data-future-status-pill]');
	const statusCopy = root.querySelector('[data-future-status-copy]');
	const saveButton = root.querySelector('[data-action="save-future-instructions"]');
	const clearButton = root.querySelector('[data-action="clear-future-instructions"]');
	if (statusPill instanceof HTMLElement) {
		statusPill.className = `status-pill ${status.tone}`;
		statusPill.textContent = status.label;
	}
	if (statusCopy instanceof HTMLElement) {
		statusCopy.textContent = status.description;
	}
	if (saveButton instanceof HTMLButtonElement) {
		saveButton.disabled = !futureInstructionsDirty();
	}
	if (clearButton instanceof HTMLButtonElement) {
		clearButton.disabled = !state.futureInstructionsDraft && !state.futureInstructions;
	}
}

function aggregateRunCounts() {
	const counts = createEmptyCounts();
	for (const job of sortedJobs()) {
		const status = jobAttentionStatus(job);
		counts[status] += 1;
	}
	return counts;
}

function filteredNotifications(job) {
	if (!job) return [];
	return job.feed.items
		.filter((item) => !state.dismissedNotificationIds[item.id])
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

function buildDetailLogLines(job) {
	if (!job) return [];
	const lines = [];
	for (const item of filteredNotifications(job)) {
		lines.push({
			id: item.id,
			kind: 'notification',
			createdAt: item.createdAt || '',
			tone: statusTone(item.status),
			prefix: `[${formatTime(item.createdAt)}] [${item.status}]`,
			text: `${item.title}${item.body ? ` - ${item.body}` : ''}`,
		});
	}
	for (const entry of filteredLogs(job)) {
		lines.push({
			id: entry.id,
			kind: 'log',
			createdAt: entry.createdAt || '',
			tone: entry.level === 'error' ? 'failed' : entry.level === 'warning' ? 'running' : 'idle',
			prefix: `[${formatTime(entry.createdAt)}] [${entry.level}]`,
			text: entry.message || 'No message',
		});
	}
	return lines.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function renderKeyValueList(rows, emptyMessage = 'No structured data available.') {
	const resolvedRows = rows.filter((row) => row && row.value != null && String(row.value).trim());
	if (!resolvedRows.length) {
		return `<article class="empty-card">${escapeHtml(emptyMessage)}</article>`;
	}
	return `
		<div class="kv-list">
			${resolvedRows
				.map(
					(row) => `
						<div class="kv-row">
							<span>${escapeHtml(row.label)}</span>
							<strong>${escapeHtml(row.value)}</strong>
						</div>
					`,
				)
				.join('')}
		</div>
	`;
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
				<p class="supporting-copy">Capabilities and deploy identity are summarized here for the active host.</p>
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
					? `
						<p class="supporting-copy detail-url">${escapeHtml(currentUrl)}</p>
						<details class="detail-disclosure">
							<summary>View deploy payload</summary>
							<pre class="detail-json">${escapeHtml(
								safeJson({
									current_url: currentUrl,
									live: status && status.live ? status.live : null,
									mirror: status && status.mirror ? status.mirror : null,
									warnings: status && status.warnings ? status.warnings : [],
								}),
							)}</pre>
						</details>
					`
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
			<details class="detail-disclosure">
				<summary>View session payload</summary>
				<pre class="detail-json">${escapeHtml(safeJson(session.args || {}))}</pre>
			</details>
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
				<button type="submit" class="action-button"${buttonDisabledAttr(!toolAvailable('job_event_feed') || !job)}>Load feed</button>
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
	const canCallTools = toolAvailable('permission_request_resolve');
	const canPrepareBundle = toolAvailable('request_permission_bundle');
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
				<button type="button" class="action-button" data-action="prepare-approval"${buttonDisabledAttr(!canPrepareBundle || !job)}>Prepare bundle</button>
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
	const canCallTools = toolAvailable('job_control');
	const canPause = canCallTools && Boolean(job && job.run) && controlState !== 'paused' && controlState !== 'cancelled' && runStatus !== 'completed';
	const canResume = canCallTools && Boolean(job && job.run) && controlState === 'paused';
	const canRetry = canCallTools && Boolean(job && job.run) && (runStatus === 'failed' || runStatus === 'interrupted');
	const canCancel = canCallTools && Boolean(job && job.run) && controlState !== 'cancelled' && runStatus !== 'completed';
	const canRefresh = toolAvailable('job_progress') && Boolean(job);
	const canLoadFeed = toolAvailable('job_event_feed') && Boolean(job);
	const canBuildIncident = toolAvailable('incident_bundle_create') && Boolean(job && job.repo && job.repo.includes('/'));
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
				<button type="button" class="mini-button" data-action="load-feed"${buttonDisabledAttr(!canLoadFeed)}>Load feed</button>
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

function attentionShortcutLabel(job) {
	if (!job) return 'Run';
	const attention = jobAttentionStatus(job);
	const controlState = job.control && job.control.state ? job.control.state : job.run?.controlState || 'active';
	if (job.approval && job.approval.pending && job.approval.requestId) return 'Resolve Approval';
	if (controlState === 'paused') return 'Resume Paused';
	if (attention === 'interrupted') return 'Retry Interrupted';
	if (attention === 'failed') return 'Retry Failed';
	if (attention === 'completed') return 'Completed';
	if (attention === 'running') return 'Running...';
	return 'Run';
}

function canRunAttentionShortcut(job) {
	if (!job) return false;
	if (job.approval && job.approval.pending && job.approval.requestId) {
		return toolAvailable('permission_request_resolve') || toolAvailable('job_control');
	}
	return toolAvailable('job_control');
}

function quickActionLabel(job) {
	if (!job) return 'Run';
	return attentionShortcutLabel(job);
}

function canRunQuickAction(job) {
	if (!job) return false;
	const shortcut = attentionShortcutLabel(job);
	if (shortcut === 'Running...' || shortcut === 'Completed' || shortcut === 'Run') return false;
	if (browserControlConnected() && externalBrowserControlAvailable() && !browserControlPending()) {
		return true;
	}
	return canRunAttentionShortcut(job);
}

function quickActionReason(job) {
	if (!job) return 'Select a run to continue.';
	if (browserControlPendingForJob(job)) {
		const pending = browserControlPendingForJob(job);
		return `${pending.label || browserControlCommandLabel(pending.kind)} is queued for the global browser companion.`;
	}
	if (browserControlBusyWithOtherJob(job)) {
		const pending = browserControlPending();
		const targetLabel = browserControlTargetLabel(pending);
		return targetLabel
			? `The global browser companion is busy with ${targetLabel}.`
			: 'The global browser companion is busy with another run.';
	}
	if (browserControlConnected() && externalBrowserControlAvailable()) {
		const pageUrl = currentBrowserControl()?.session?.pageUrl || '';
		return pageUrl
			? `A global browser companion is attached to ${pageUrl}. Quick action will use real ChatGPT clicks.`
			: 'A global browser companion is connected. Quick action will use real ChatGPT clicks.';
	}
	const attention = jobAttentionStatus(job);
	if (job.approval && job.approval.pending && job.approval.requestId) {
		return job.blockingState?.reason || 'Approval is required before continuing.';
	}
	if (attention === 'interrupted') {
		return currentInterrupt(job)?.message || job.blockingState?.reason || 'The run was interrupted.';
	}
	if (attention === 'failed') {
		return job.blockingState?.reason || job.run?.lastEvent || 'The run failed and can be retried.';
	}
	if (attention === 'completed') {
		return job.run?.lastEvent || 'The run has already completed.';
	}
	if (attention === 'running') {
		return job.run?.lastEvent || 'The run is still active.';
	}
	if (job.control && job.control.state === 'paused') {
		return job.control.reason || job.blockingState?.reason || 'The run is paused.';
	}
	return job.run?.lastEvent || 'No follow-up action is required yet.';
}

function renderStandaloneAuthAction() {
	if (window.parent && window.parent !== window) {
		return '';
	}
	if (state.session.ready || state.standaloneToken.trim()) {
		return '<button type="button" class="mini-button" data-action="browser-logout">Log out</button>';
	}
	if (state.auth.enabled) {
		return `<button type="button" class="mini-button" data-action="begin-browser-login"${buttonDisabledAttr(state.auth.loading)}>Log in</button>`;
	}
	return '';
}

function renderStandaloneAccessPanel() {
	if (window.parent && window.parent !== window) {
		return '';
	}
	if (state.session.ready) {
		return '';
	}
	return `
		<section class="panel compact-panel utility-panel">
			<div class="stack-header">
				<p class="panel-kicker">Standalone Access</p>
				<h2>Connect the web control API</h2>
				<p class="supporting-copy">Use browser login or a bearer token to keep queue control available outside the host bridge.</p>
			</div>
			<div class="utility-grid">
				<article class="detail-card utility-card">
					<div class="stack-header">
						<p class="panel-kicker">Browser Login</p>
						<h3>Auth0 sign-in</h3>
						<p class="supporting-copy">Prefer browser login when OIDC is configured for the operator flow.</p>
					</div>
					<div class="action-row">
						<button type="button" class="action-button" data-action="begin-browser-login"${buttonDisabledAttr(!state.auth.enabled || state.auth.loading)}>
							${escapeHtml(state.auth.loading ? 'Loading login config...' : 'Sign in')}
						</button>
						<button type="button" class="mini-button" data-action="retry-auth-config"${buttonDisabledAttr(state.auth.loading)}>Reload config</button>
					</div>
					${state.auth.error ? `<article class="empty-card">${escapeHtml(state.auth.error)}</article>` : ''}
					${!state.auth.error && state.auth.missing.length ? `<article class="empty-card">Login is unavailable until ${escapeHtml(state.auth.missing.join(', '))} is configured.</article>` : ''}
				</article>
				<article class="detail-card utility-card">
					<div class="stack-header">
						<p class="panel-kicker">Manual Token</p>
						<h3>Paste a bearer token</h3>
						<p class="supporting-copy">Use this path when browser login is disabled or you already have an operator token.</p>
					</div>
					<div class="field-stack">
						<label for="standalone-token">Bearer token</label>
						<textarea id="standalone-token" class="command-textarea" name="standalone-token" placeholder="Paste a ChatGPT MCP bearer token when Cloudflare Access is not available.">${escapeHtml(state.standaloneToken)}</textarea>
					</div>
					<div class="action-row">
						<button type="button" class="action-button" data-action="save-standalone-token">Save token</button>
						<button type="button" class="mini-button" data-action="retry-standalone-session">Retry</button>
						<button type="button" class="mini-button" data-action="clear-standalone-token"${buttonDisabledAttr(!state.standaloneToken.trim())}>Clear</button>
						<button type="button" class="mini-button" data-action="load-demo">Demo mode</button>
					</div>
				</article>
			</div>
			${state.session.error ? `<article class="empty-card">${escapeHtml(state.session.error)}</article>` : ''}
		</section>
	`;
}

function externalBrowserControlAvailable() {
	return window.parent === window && state.session.ready;
}

function currentBrowserControl() {
	return state.store.browserControl || null;
}

function browserControlConnected() {
	return Boolean(currentBrowserControl()?.session && currentBrowserControl().session.status === 'connected');
}

function browserControlPending() {
	return currentBrowserControl()?.pendingCommand || null;
}

function browserControlPendingForJob(job = currentJob()) {
	if (!job) return null;
	const pending = browserControlPending();
	return pending && pending.jobId === job.jobId ? pending : null;
}

function browserControlBusyWithOtherJob(job = currentJob()) {
	const pending = browserControlPending();
	return Boolean(pending && job && pending.jobId && pending.jobId !== job.jobId);
}

function browserControlTargetLabel(target) {
	if (!target) return '';
	return target.jobTitle || target.jobId || target.repo || '';
}

function browserControlCommandLabel(kind) {
	if (kind === 'send_prompt') return 'Send prompt';
	if (kind === 'auto_continue_run') return 'Auto continue';
	return 'Click continue';
}

function browserCompanionCommand(options = {}) {
	const includeToken = options.includeToken === true;
	const authPart = state.standaloneToken.trim()
		? includeToken
			? `--bearer-token "${state.standaloneToken.trim()}"`
			: '--bearer-token <saved-token>'
		: '--queue-token <queue-token>';
	return `npm run browser:companion -- --app-origin ${config.appOrigin} ${authPart} --cdp-url http://127.0.0.1:9222`;
}

async function refreshBrowserControl(options = {}) {
	if (!externalBrowserControlAvailable()) return null;
	const payload = await apiRequest('/gui/api/browser-control');
	state.store.browserControl = normalizeBrowserControl(payload.data && payload.data.browser_control ? payload.data.browser_control : null);
	if (!options.skipRender) {
		render();
	}
	return payload;
}

async function enqueueBrowserControlCommand(jobId, input = {}) {
	if (!jobId) {
		state.error = 'Select a run before queueing a browser control command.';
		render();
		return null;
	}
	if (!externalBrowserControlAvailable()) {
		state.error = 'External browser control requires the standalone web console with operator login.';
		render();
		return null;
	}
	state.error = '';
	state.message = `Queueing ${input.label || browserControlCommandLabel(input.kind)}...`;
	render();
	try {
		const job = ensureJob(jobId);
		const payload = await apiRequest('/gui/api/browser-control/commands', {
			method: 'POST',
			body: {
				job_id: jobId,
				job_title: job && job.run ? job.run.title : jobId,
				repo: job ? job.repo : null,
				kind: input.kind,
				label: input.label,
				prompt: input.prompt,
				page_url_hint: typeof config.chatUiUrl === 'string' ? config.chatUiUrl : null,
			},
		});
		state.store.browserControl = normalizeBrowserControl(payload.data && payload.data.browser_control ? payload.data.browser_control : null);
		state.message = `${input.label || browserControlCommandLabel(input.kind)} queued for the global browser companion.`;
		render();
		return payload;
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.message = '';
		render();
		return null;
	}
}

async function runExternalBrowserShortcut(jobId = currentJob()?.jobId || '') {
	const job = ensureJob(jobId);
	if (!job) return;
	await enqueueBrowserControlCommand(jobId, {
		kind: 'click_continue',
		label: attentionShortcutLabel(job),
	});
}

function renderDashboardJobs() {
	const jobs = dashboardJobs();
	const selectedJobId = currentRouteJobId();
	if (!jobs.length) {
		return `
			<section class="panel info-panel">
				<article class="empty-card">No runs matched the current search or filter.</article>
			</section>
		`;
	}
	return `
		<section class="job-grid" aria-label="Run list">
			${jobs
				.map((job) => {
					const attention = jobAttentionStatus(job);
					const isSelected = selectedJobId === job.jobId;
					const canRun = canRunQuickAction(job);
					const quickLabel = quickActionLabel(job);
					const quickReason = quickActionReason(job);
					const categories = [job.repo, job.nextActor ? `next:${job.nextActor}` : ''].filter(Boolean);
					return `
						<article class="job-card${isSelected ? ' is-selected' : ''}" data-select-job="${escapeHtml(job.jobId)}" data-card-state="${escapeHtml(attention)}" tabindex="0" role="button" aria-label="${escapeHtml(job.run ? job.run.title : job.jobId)}">
							<div class="job-card-main">
								<div class="job-card-copy">
									<div class="job-card-heading">
										<h3>${escapeHtml(job.run ? job.run.title : job.jobId)}</h3>
									</div>
									<p class="supporting-copy">${escapeHtml(job.run && job.run.lastEvent ? job.run.lastEvent : job.blockingState?.reason || 'No summary yet.')}</p>
									<div class="meta-row">
										${statusPill(attention)}
										${categories
											.map((label) => `<span class="run-category">${escapeHtml(label)}</span>`)
											.join('')}
									</div>
								</div>
								<div class="job-card-actions">
									<button type="button" class="card-run-button" data-action="job-shortcut" data-job-id="${escapeHtml(job.jobId)}"${buttonDisabledAttr(!canRun)}>${runIcon('inline-icon')}${escapeHtml(quickLabel)}</button>
									<p class="action-reason">${escapeHtml(quickReason)}</p>
								</div>
							</div>
							<div class="job-card-footer">
								<span>${clockIcon('inline-icon')}Updated ${escapeHtml(job.run?.updatedAt ? formatRelativeTime(job.run.updatedAt) : 'Unknown')}</span>
								${job.run && job.run.progressPercent != null ? `<span class="mono-copy">${escapeHtml(`${job.run.progressPercent}%`)}</span>` : ''}
							</div>
						</article>
					`;
				})
				.join('')}
		</section>
	`;
}

function renderDetailOverview(job) {
	if (!job || !job.run) {
		return `
			<section class="detail-tab-panel">
				<article class="empty-card">No run metadata is available yet.</article>
			</section>
		`;
	}
	return `
		<section class="detail-tab-panel">
			<div class="detail-card simple-card">
				<div class="stack-header">
					<p class="panel-kicker">Info</p>
					<h3>Run metadata</h3>
				</div>
				${renderKeyValueList([
					{ label: 'Status', value: statusLabel(jobAttentionStatus(job)) },
					{ label: 'Control', value: job.control && job.control.state ? job.control.state : job.run.controlState || 'active' },
					{ label: 'Updated', value: formatTime(job.run.updatedAt) },
					{ label: 'Progress', value: `${job.run.progressPercent}%` },
					{ label: 'Workflow', value: job.run.workflowRunId != null ? `#${job.run.workflowRunId}` : '' },
					{ label: 'Preview', value: job.run.previewId || '' },
					{ label: 'Approval', value: job.approval && job.approval.requestId ? job.approval.requestId : '' },
					{ label: 'Next actor', value: job.nextActor || 'system' },
				])}
			</div>
			<div class="detail-card simple-card">
				<div class="stack-header">
					<p class="panel-kicker">Environment</p>
					<h3>Host state</h3>
				</div>
				${renderKeyValueList([
					{ label: 'Bridge', value: currentBridgeLabel() },
					{ label: 'Operator', value: state.session.email || '' },
					{ label: 'Deploy env', value: state.store.host.currentDeploy?.environment || '' },
					{ label: 'Current URL', value: state.store.host.currentDeploy?.currentUrl || '' },
					{ label: 'Release', value: state.store.host.currentDeploy?.releaseCommitSha || '' },
				], 'Host metadata has not been loaded yet.')}
			</div>
			${renderBrowserControlCard(job)}
		</section>
	`;
}

function renderDetailLogs(job) {
	if (!job || !job.run) {
		return `
			<section class="detail-tab-panel">
				<article class="empty-card">No logs available yet.</article>
			</section>
		`;
	}
	const lines = buildDetailLogLines(job);
	return `
		<section class="detail-tab-panel">
			<div class="detail-card simple-card">
				<div class="stack-header">
					<p class="panel-kicker">Logs</p>
					<h3>Run activity</h3>
					<p class="supporting-copy">Notifications and layer logs for the selected run are merged into a single console view.</p>
				</div>
				<div class="console-block">
					${
						lines.length
							? lines
									.map(
										(line) => `
											<div class="console-line ${escapeHtml(line.tone)}">
												<span class="console-prefix">${escapeHtml(line.prefix)}</span>
												<span>${escapeHtml(line.text)}</span>
											</div>
										`,
									)
									.join('')
							: '<p class="console-empty">No logs available yet.</p>'
					}
				</div>
			</div>
		</section>
	`;
}

function renderDetailInputs(job) {
	if (!job || !job.run) {
		return `
			<section class="detail-tab-panel">
				<article class="empty-card">No run inputs are available yet.</article>
			</section>
		`;
	}
	const targetPaths = Array.isArray(job.targetPaths) ? job.targetPaths.filter(Boolean) : [];
	return `
		<section class="detail-tab-panel">
			<div class="detail-card simple-card">
				<div class="stack-header">
					<p class="panel-kicker">Inputs</p>
					<h3>Current run inputs</h3>
				</div>
				${renderKeyValueList([
					{ label: 'Job ID', value: job.jobId },
					{ label: 'Repo', value: job.repo || '' },
					{ label: 'Run ID', value: job.run.runId || '' },
					{ label: 'Blocked action', value: job.blockingState?.blockedAction || '' },
					{ label: 'Reason', value: job.blockingState?.reason || '' },
					{ label: 'Approval request', value: job.approval && job.approval.requestId ? job.approval.requestId : '' },
					{ label: 'Latest notification', value: job.latestNotification?.title || '' },
					{ label: 'Target paths', value: targetPaths.join(', ') },
				])}
			</div>
		</section>
	`;
}

function renderDetailFuture(job) {
	const status = futureInstructionsStatus();
	return `
		<section class="detail-tab-panel">
			<div class="detail-card simple-card">
				<div class="stack-header">
					<p class="panel-kicker">Future</p>
					<h3>Future instructions</h3>
					<p class="supporting-copy">These instructions are synced into GPT model context so the run can continue with fewer manual restarts when the web session interrupts.</p>
					<div class="future-status-row">
						<span class="status-pill ${escapeHtml(status.tone)}" data-future-status-pill>${escapeHtml(status.label)}</span>
						<span class="future-status-copy" data-future-status-copy>${escapeHtml(status.description)}</span>
					</div>
				</div>
				<div class="field-stack">
					<label for="future-instructions">Future instructions</label>
					<textarea
						id="future-instructions"
						class="command-textarea future-textarea"
						name="future-instructions"
						placeholder="Describe what GPT should verify before ending the task and how it should continue if the session reconnects."
					>${escapeHtml(state.futureInstructionsDraft)}</textarea>
				</div>
				<div class="action-row">
					<button type="button" class="action-button" data-action="save-future-instructions"${buttonDisabledAttr(!futureInstructionsDirty())}>Save</button>
					<button type="button" class="mini-button" data-action="clear-future-instructions"${buttonDisabledAttr(!state.futureInstructionsDraft && !state.futureInstructions)}>Clear</button>
				</div>
				<div class="future-preview">
					<p class="panel-kicker">Saved Preview</p>
					${
						state.futureInstructions.trim()
							? `<pre class="detail-json">${escapeHtml(state.futureInstructions)}</pre>`
							: '<article class="empty-card">No saved future instructions yet.</article>'
					}
				</div>
				${job ? `<p class="supporting-copy">Current run: ${escapeHtml(job.run ? job.run.title : job.jobId)}</p>` : ''}
			</div>
		</section>
	`;
}

function renderBrowserControlCard(job) {
	const control = currentBrowserControl();
	const session = control && control.session ? control.session : null;
	const pending = control && control.pendingCommand ? control.pendingCommand : null;
	const lastResult = control && control.lastResult ? control.lastResult : null;
	const activeJob = control && control.activeJob ? control.activeJob : null;
	const connected = browserControlConnected();
	const canQueue = Boolean(job) && connected && externalBrowserControlAvailable() && !pending;
	const canCopyCommand = window.parent === window;
	const launchCommand = browserCompanionCommand();
	return `
		<div class="detail-card simple-card">
			<div class="stack-header">
				<p class="panel-kicker">Remote</p>
				<h3>Browser companion</h3>
				<p class="supporting-copy">Attach one local Chrome or Edge session via CDP so the console can drive any selected run with real ChatGPT clicks.</p>
			</div>
			${renderKeyValueList([
				{ label: 'Status', value: session ? session.status : 'disconnected' },
				{ label: 'Agent', value: session && session.agentName ? session.agentName : '' },
				{ label: 'Last seen', value: session && session.lastSeenAt ? formatRelativeTime(session.lastSeenAt) : '' },
				{ label: 'Page', value: session && session.pageUrl ? session.pageUrl : '' },
				{ label: 'Active run', value: browserControlTargetLabel(activeJob) },
				{ label: 'Pending', value: pending ? `${pending.label || browserControlCommandLabel(pending.kind)}${pending.jobId ? ` (${pending.jobId})` : ''}` : '' },
				{ label: 'Last result', value: lastResult ? `${lastResult.ok ? 'success' : 'failed'}${lastResult.jobId ? ` (${lastResult.jobId})` : ''}` : '' },
			], 'Open the full-page console, sign in, then attach the global browser companion to enable real-click ChatGPT control.')}
			${
				pending
					? `<article class="empty-card remote-state-card">
						<strong>${escapeHtml(pending.label || browserControlCommandLabel(pending.kind))}</strong>
						${pending.jobId ? `<p>${escapeHtml(`Target run: ${browserControlTargetLabel(pending) || pending.jobId}`)}</p>` : ''}
						<p>${escapeHtml(pending.claimedAt ? `Claimed ${formatRelativeTime(pending.claimedAt)} by ${pending.claimedBy || 'the companion'}.` : `Queued ${formatRelativeTime(pending.createdAt)}.`)}</p>
					</article>`
					: ''
			}
			${
				lastResult
					? `<article class="empty-card remote-state-card${lastResult.ok ? '' : ' error'}">
						<strong>${escapeHtml(lastResult.ok ? 'Last command passed' : 'Last command failed')}</strong>
						${lastResult.jobId ? `<p>${escapeHtml(`Target run: ${browserControlTargetLabel(lastResult) || lastResult.jobId}`)}</p>` : ''}
						<p>${escapeHtml(lastResult.summary || lastResult.error || 'No summary was recorded.')}</p>
					</article>`
					: ''
			}
			<div class="action-row">
				${
					externalBrowserControlAvailable()
						? `
							<button type="button" class="action-button" data-action="browser-click-continue" data-job-id="${escapeHtml(job ? job.jobId : '')}"${buttonDisabledAttr(!canQueue)}>Click Continue</button>
							<button type="button" class="action-button secondary" data-action="browser-send-future" data-job-id="${escapeHtml(job ? job.jobId : '')}"${buttonDisabledAttr(!canQueue || (!state.futureInstructions.trim() && !currentChatDraft(job).trim()))}>Send Saved Future</button>
							<button type="button" class="mini-button" data-action="browser-auto-continue" data-job-id="${escapeHtml(job ? job.jobId : '')}"${buttonDisabledAttr(!canQueue)}>Auto Continue + Send</button>
						`
						: `<button type="button" class="action-button" data-action="open-full-page">Open full page</button>`
				}
			</div>
			<div class="action-row">
				<button type="button" class="mini-button" data-action="refresh-browser-control"${buttonDisabledAttr(!externalBrowserControlAvailable())}>Refresh remote state</button>
				<button type="button" class="mini-button" data-action="copy-browser-companion-command"${buttonDisabledAttr(!canCopyCommand)}>Copy launch command</button>
			</div>
			<div class="future-preview">
				<p class="panel-kicker">Launch</p>
				<pre class="detail-json remote-command-preview">${escapeHtml(launchCommand || 'Open the full-page console to generate the companion command.')}</pre>
			</div>
		</div>
	`;
}

function renderChat(job, host) {
	const draft = currentChatDraft(job);
	const primaryActionLabel = host.canSendMessage() ? 'Send to ChatGPT' : 'Copy + Open ChatGPT';
	return `
		<section class="panel action-panel" id="section-chat" data-section="chat">
			<div class="stack-header">
				<p class="panel-kicker">Chat</p>
				<h2>Prepare the next ChatGPT instruction</h2>
				<p class="supporting-copy">Inside a compatible host this page can send the next instruction directly. In the standalone web view it falls back to copying the draft and opening ChatGPT in a new tab.</p>
			</div>
			<div class="field-stack">
				<label for="chat-draft">Chat draft</label>
				<textarea id="chat-draft" class="command-textarea" name="chat-draft" placeholder="Describe the next coding action for ChatGPT.">${escapeHtml(draft)}</textarea>
			</div>
			<div class="action-row">
				<button type="button" class="action-button" data-action="send-chat-draft">${escapeHtml(primaryActionLabel)}</button>
				<button type="button" class="action-button secondary" data-action="copy-chat-draft">Copy prompt</button>
				<button type="button" class="mini-button" data-action="open-chat-ui">Open ChatGPT</button>
			</div>
		</section>
		<section class="panel info-panel">
			<div class="split-grid">
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Prompt Preview</p>
						<h3>Current message</h3>
					</div>
					<pre class="detail-json">${escapeHtml(draft)}</pre>
				</div>
				<div class="detail-card">
					<div class="stack-header">
						<p class="panel-kicker">Context Snapshot</p>
						<h3>Run state for the next message</h3>
					</div>
					<pre class="detail-json">${escapeHtml(safeJson(buildContextSnapshot()))}</pre>
				</div>
			</div>
		</section>
	`;
}

function renderTopbar(host) {
	const job = currentJob();
	const counts = aggregateRunCounts();
	const page = currentPage();
	const alertPermission = browserAlertsSupported() ? window.Notification.permission : 'unsupported';
	const sessionLabel = state.session.email || currentBridgeLabel();
	if (page === 'detail') {
		return `
			<header class="topbar">
				<div class="hero-copy">
					<p class="eyebrow">MCP Run Console</p>
					<h1>${escapeHtml(job && job.run ? job.run.title : APP_INFO.title)}</h1>
					<p class="lede">${escapeHtml(job ? `${job.jobId} · ${job.repo || 'Repository pending'}` : 'Open a tracked run from the list.')}</p>
					<div class="action-row">
						<button type="button" class="action-button" data-action="back-to-list">Back to list</button>
						<button type="button" class="action-button secondary" data-action="job-shortcut" data-job-id="${escapeHtml(job ? job.jobId : '')}"${buttonDisabledAttr(!job || !canRunAttentionShortcut(job) || attentionShortcutLabel(job) === 'Open')}>${escapeHtml(attentionShortcutLabel(job))}</button>
						<button type="button" class="mini-button" data-action="refresh-run"${buttonDisabledAttr(!toolAvailable('job_progress') || !job)}>Refresh</button>
						${renderStandaloneAuthAction()}
					</div>
				</div>
				<div class="topbar-meta topbar-meta-wide">
					<article class="topbar-card"><span>Bridge</span><strong>${escapeHtml(currentBridgeLabel())}</strong></article>
					<article class="topbar-card"><span>Operator</span><strong>${escapeHtml(sessionLabel)}</strong></article>
					<article class="topbar-card"><span>Open approvals</span><strong>${escapeHtml(Object.values(state.store.jobs).filter((entry) => entry.approval && entry.approval.status === 'requested').length)}</strong></article>
					<article class="topbar-card"><span>Interrupted runs</span><strong>${escapeHtml(counts.interrupted)}</strong></article>
				</div>
			</header>
		`;
	}
	return `
		<header class="topbar">
			<div class="hero-copy">
				<p class="eyebrow">MCP Run Console</p>
				<h1>${escapeHtml(APP_INFO.title)}</h1>
				<p class="lede">Compact first screen for project runs, approval waits, interrupt alerts, and one-click retry or resume actions.</p>
				<div class="action-row">
					<button type="button" class="action-button" data-action="load-jobs"${buttonDisabledAttr(!toolAvailable('jobs_list'))}>Load runs</button>
					<button type="button" class="action-button secondary" data-action="retry-standalone-session"${buttonDisabledAttr(window.parent && window.parent !== window)}>Reconnect API</button>
					<button type="button" class="mini-button" data-action="enable-alerts"${buttonDisabledAttr(!browserAlertsSupported() || alertPermission === 'granted')}>${escapeHtml(alertPermission === 'granted' ? 'Alerts enabled' : 'Enable alerts')}</button>
					${renderStandaloneAuthAction()}
				</div>
			</div>
			<div class="topbar-meta topbar-meta-wide">
				<article class="topbar-card"><span>Bridge</span><strong>${escapeHtml(currentBridgeLabel())}</strong></article>
				<article class="topbar-card"><span>Operator</span><strong>${escapeHtml(sessionLabel)}</strong></article>
				<article class="topbar-card"><span>Open approvals</span><strong>${escapeHtml(Object.values(state.store.jobs).filter((entry) => entry.approval && entry.approval.status === 'requested').length)}</strong></article>
				<article class="topbar-card"><span>Interrupted runs</span><strong>${escapeHtml(counts.interrupted)}</strong></article>
			</div>
		</header>
	`;
}

function renderNavigation() {
	if (currentPage() !== 'detail') {
		return '';
	}
	const tabs = [
		['logs', 'Logs'],
		['inputs', 'Inputs'],
		['info', 'Info'],
		['future', 'Future'],
	];
	return `
		<nav class="tab-row detail-tab-row" aria-label="Run console sections">
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

function renderDashboard() {
	return `
		<section class="panel hero-panel">
			<div class="hero-copy">
				<p class="panel-kicker">Queue</p>
				<h2>Project attention summary</h2>
				<p class="supporting-copy">Approval waits, interrupted runs, and failed jobs are polled in the background and can raise browser notifications.</p>
			</div>
			<div class="hero-side">${renderCountsGrid(aggregateRunCounts())}</div>
		</section>
		${renderStandaloneAccessPanel()}
		${renderDashboardJobs()}
	`;
}

function renderDetailSection(job, host) {
	if (state.focusSection === 'logs') return renderDetailLogs(job);
	if (state.focusSection === 'inputs') return renderDetailInputs(job);
	if (state.focusSection === 'future') return renderDetailFuture(job);
	return renderDetailOverview(job);
}

function renderNotificationCenter() {
	const items = buildNotificationCenterItems();
	const unread = unreadNotificationCount();
	return `
		<div class="notification-shell" data-notification-menu>
			<button type="button" class="icon-button notification-button" data-action="toggle-notifications" aria-label="Open notifications" aria-expanded="${state.notificationMenuOpen ? 'true' : 'false'}">
				${bellIcon('icon')}
				${unread ? `<span class="notification-badge">${escapeHtml(unread)}</span>` : ''}
			</button>
			${
				state.notificationMenuOpen
					? `
						<div class="notification-menu" data-notification-menu>
							<div class="notification-menu-header">
								<h3>Notifications</h3>
							</div>
							${
								items.length
									? `<div class="notification-list">
										${items
											.map(
												(item) => `
													<button type="button" class="notification-entry${state.seenAlertKeys[item.key] ? '' : ' is-unread'}" data-action="dismiss-notification" data-alert-key="${escapeHtml(item.key)}"${item.notificationId ? ` data-notification-id="${escapeHtml(item.notificationId)}"` : ''}>
														<p>${escapeHtml(item.body || item.title)}</p>
														<span>${escapeHtml(formatRelativeTime(item.createdAt))}</span>
													</button>
												`,
											)
											.join('')}
									</div>`
									: '<div class="notification-empty">No notifications</div>'
							}
						</div>
					`
					: ''
			}
		</div>
	`;
}

function renderDashboardHeader() {
	const filteredRuns = dashboardJobs().length;
	const totalRuns = sortedJobs().length;
	const autoRefreshLabel = canAutoRefresh() ? `Auto ${Math.round(POLL_INTERVAL_MS / 1000)}s` : 'Manual';
	return `
		<header class="topbar dashboard-topbar">
			<div class="topbar-main">
				<div class="topbar-brand">
					<div class="brand-mark">${runIcon('brand-icon')}</div>
					<div>
						<h1>Run Console</h1>
						<p class="brand-subtitle">MCP Worker Dashboard</p>
					</div>
				</div>
				<div class="topbar-side">
					<span class="run-counter">${escapeHtml(filteredRuns)}/${escapeHtml(totalRuns)} runs · ${escapeHtml(autoRefreshLabel)}</span>
					${renderNotificationCenter()}
				</div>
			</div>
			<div class="topbar-toolbar">
				<label class="header-search">
					${searchIcon('icon')}
					<input type="search" name="dashboard-search" value="${escapeHtml(state.dashboardSearch)}" placeholder="Search runs..." autocomplete="off" />
				</label>
				<div class="header-filters">
					<select name="dashboard-status" aria-label="Filter runs by status">
						<option value="all"${selectedAttr(state.dashboardStatus, 'all')}>All Status</option>
						${ATTENTION_STATUSES.map((status) => `<option value="${escapeHtml(status)}"${selectedAttr(state.dashboardStatus, status)}>${escapeHtml(statusLabel(status))}</option>`).join('')}
					</select>
					<select name="dashboard-sort" aria-label="Sort runs">
						<option value="name"${selectedAttr(state.dashboardSort, 'name')}>Sort: Name</option>
						<option value="status"${selectedAttr(state.dashboardSort, 'status')}>Sort: Status</option>
						<option value="recent"${selectedAttr(state.dashboardSort, 'recent')}>Sort: Recent</option>
					</select>
				</div>
				<div class="topbar-actions">
					<button type="button" class="action-button" data-action="load-jobs"${buttonDisabledAttr(!toolAvailable('jobs_list'))}>${refreshIcon('inline-icon')}Load runs</button>
					<button type="button" class="action-button secondary" data-action="retry-standalone-session"${buttonDisabledAttr(window.parent && window.parent !== window)}>Reconnect API</button>
					${renderStandaloneAuthAction()}
				</div>
			</div>
		</header>
	`;
}

function renderWorkspaceSummary() {
	return `
		<section class="panel hero-panel dashboard-summary">
			<div class="hero-copy">
				<p class="panel-kicker">Queue</p>
				<h2>Project attention summary</h2>
				<p class="supporting-copy">Approval waits, interrupted runs, failures, and queue control stay visible from one operator surface.</p>
			</div>
			<div class="hero-side">${renderCountsGrid(aggregateRunCounts())}</div>
		</section>
	`;
}

function renderWorkspaceDetailPane(job, host) {
	const isOpen = Boolean(job);
	const runStatus = job ? jobAttentionStatus(job) : 'idle';
	const canRun = job ? canRunQuickAction(job) : false;
	const actionLabel = job ? quickActionLabel(job) : 'Run';
	const actionReason = job ? quickActionReason(job) : 'Select a run to continue.';
	return `
		${isOpen ? '<button type="button" class="drawer-backdrop" data-action="close-detail" aria-label="Close detail panel"></button>' : ''}
		<aside class="workspace-side${isOpen ? ' is-open' : ''}">
			<div class="detail-pane">
				${
					job && job.run
						? `
							<div class="detail-pane-header">
								<div class="detail-pane-copy">
									<div class="stack-header">
										<div class="meta-row">
											${statusPill(runStatus)}
											${job.repo ? `<span class="run-category">${escapeHtml(job.repo)}</span>` : ''}
										</div>
										<h2>${escapeHtml(job.run.title)}</h2>
										<p class="supporting-copy">${escapeHtml(job.run.lastEvent || job.jobId)}</p>
									</div>
								</div>
								<button type="button" class="icon-button detail-close-button" data-action="close-detail" aria-label="Close detail panel">${closeIcon('icon')}</button>
							</div>
							<div class="detail-pane-actions">
								<button type="button" class="detail-primary-button" data-action="job-shortcut" data-job-id="${escapeHtml(job.jobId)}"${buttonDisabledAttr(!canRun)}>${runIcon('inline-icon')}${escapeHtml(actionLabel)}</button>
								<div class="detail-meta-copy">
									<span class="detail-meta-text">${escapeHtml(actionReason)}</span>
									<span class="detail-meta-subtext">Updated ${escapeHtml(job.run.updatedAt ? formatRelativeTime(job.run.updatedAt) : 'Unknown')}</span>
								</div>
							</div>
							${renderNavigation()}
							<div class="detail-pane-body">${renderDetailSection(job, host)}</div>
						`
						: `
							<div class="detail-pane-empty">
								<div class="empty-state-icon">${runIcon('brand-icon')}</div>
								<h3>No run selected</h3>
								<p class="supporting-copy">Click a run card to view details, logs, and execution state.</p>
							</div>
						`
				}
			</div>
		</aside>
	`;
}

function render() {
	const job = currentRouteJobId() ? currentJob() : null;
	const host = currentHostApi();
	root.innerHTML = `
		<div class="app-shell">
			${renderDashboardHeader()}
			${state.error ? `<div class="banner error">${escapeHtml(state.error)}</div>` : ''}
			<div class="workspace-shell${job ? ' has-selection' : ''}">
				<div class="workspace-main">
					${renderDashboardJobs()}
				</div>
				${renderWorkspaceDetailPane(job, host)}
			</div>
			<p id="analysis-summary" class="supporting-copy"></p>
			<pre class="capture-json" id="capture-json" hidden></pre>
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
	primeBrowserAlertsBaseline();
	state.message = 'Loaded standalone demo data. Connect from the MCP host to use live tools.';
}

function hydrate() {
	restoreViewState();
	restoreStandaloneToken();
	syncRouteStateFromLocation();
	const globals = hasRecord(window.__OPENGPT_WIDGET_PAYLOAD__)
		? window.__OPENGPT_WIDGET_PAYLOAD__
		: hasRecord(window.__OPENGPT_WIDGET_DATA__)
			? window.__OPENGPT_WIDGET_DATA__
			: null;
	if (globals) {
		hydrateFromEnvelope(globals);
	}
	if (
		!openaiBridge() &&
		(!window.parent || window.parent === window) &&
		new URLSearchParams(window.location.search).get('demo') === '1'
	) {
		seedDemoStore();
	}
	if (!state.alertBaselineReady && sortedJobs().length) {
		primeBrowserAlertsBaseline();
	}
	render();
}

async function connectStandardBridge() {
	currentHostApi().setOpenInAppUrl();
	if (!window.parent || window.parent === window) {
		state.store.host.source = openaiBridge() ? 'window.openai fallback' : 'standalone';
		await refreshStandaloneAuthConfig({ skipRender: true });
		await completeStandaloneBrowserLogin({ skipRender: true });
		await refreshStandaloneSession({ skipRender: true });
		startPolling();
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
			startPolling();
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
					maybeEmitBrowserAlerts(sortedJobs());
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
			stopPolling();
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
		startPolling();
		render();
		await syncModelContext(true);
		void autoloadHostStatus().catch((error) => console.warn(error));
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.store.host.source = openaiBridge() ? 'window.openai fallback' : 'standalone';
		await refreshStandaloneSession({ skipRender: true });
		startPolling();
		render();
	}
}

root.addEventListener('click', (event) => {
	const target = event.target instanceof Element ? event.target.closest('[data-focus-section],[data-select-job],[data-select-notification],[data-select-log],[data-action]') : null;
	if (!(target instanceof HTMLElement)) return;
	if (!state.alertPermissionRequested && browserAlertsSupported() && window.Notification.permission === 'default') {
		state.alertPermissionRequested = true;
		void requestBrowserAlertsPermission().catch((error) => console.warn(error));
	}
	if (target.dataset.focusSection) {
		state.focusSection = normalizeDetailSection(target.dataset.focusSection);
		if (currentPage() === 'detail' && currentJob()) {
			navigateToJob(currentJob().jobId, state.focusSection);
		} else {
			render();
		}
		void syncModelContext(false).catch((error) => console.warn(error));
		return;
	}
	if (target.dataset.selectJob) {
		state.selectedNotificationId = '';
		state.selectedLogId = '';
		state.notificationMenuOpen = false;
		state.utilityMenuOpen = false;
		navigateToJob(target.dataset.selectJob, 'logs');
		void refreshCurrentRun({ silent: true, keepSection: true });
		void loadFeed({ silent: true, keepSection: true });
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
		case 'toggle-access-menu':
			state.utilityMenuOpen = !state.utilityMenuOpen;
			if (state.utilityMenuOpen) {
				state.notificationMenuOpen = false;
			}
			render();
			break;
		case 'toggle-notifications':
			state.notificationMenuOpen = !state.notificationMenuOpen;
			if (state.notificationMenuOpen) {
				state.utilityMenuOpen = false;
				if (browserAlertsSupported() && window.Notification.permission === 'default') {
					void requestBrowserAlertsPermission().catch((error) => console.warn(error));
				}
			}
			if (state.notificationMenuOpen) {
				markNotificationsSeen();
			}
			render();
			break;
		case 'clear-notifications':
			for (const item of buildNotificationCenterItems()) {
				state.dismissedAlertKeys[item.key] = true;
				if (item.notificationId) {
					state.dismissedNotificationIds[item.notificationId] = true;
				}
			}
			state.notificationMenuOpen = false;
			render();
			break;
		case 'dismiss-notification':
			if (target.dataset.alertKey) {
				state.dismissedAlertKeys[target.dataset.alertKey] = true;
			}
			if (target.dataset.notificationId) {
				state.dismissedNotificationIds[target.dataset.notificationId] = true;
			}
			render();
			break;
		case 'open-notification': {
			const sectionTarget = target.dataset.sectionTarget;
			if (target.dataset.alertKey) {
				state.seenAlertKeys[target.dataset.alertKey] = true;
			}
			if (target.dataset.notificationId) {
				state.selectedNotificationId = target.dataset.notificationId;
			}
			state.notificationMenuOpen = false;
			if (target.dataset.jobId) {
				navigateToJob(target.dataset.jobId, normalizeDetailSection(sectionTarget));
			}
			break;
		}
		case 'open-job':
			if (target.dataset.jobId) {
				state.selectedJobId = target.dataset.jobId;
				navigateToJob(target.dataset.jobId, 'logs');
				void refreshCurrentRun({ silent: true, keepSection: true });
				void loadFeed({ silent: true, keepSection: true });
				if (externalBrowserControlAvailable()) {
					void refreshBrowserControl().catch((error) => console.warn(error));
				}
			}
			break;
		case 'back-to-list':
		case 'close-detail':
			state.notificationMenuOpen = false;
			state.utilityMenuOpen = false;
			navigateToList();
			break;
		case 'job-shortcut':
			if (browserControlConnected() && externalBrowserControlAvailable()) {
				void runExternalBrowserShortcut(target.dataset.jobId || currentJob()?.jobId || '');
			} else {
				void runAttentionShortcut(target.dataset.jobId || currentJob()?.jobId || '');
			}
			break;
		case 'refresh-browser-control':
			void refreshBrowserControl();
			break;
		case 'copy-browser-companion-command': {
			const text = browserCompanionCommand({ includeToken: true });
			if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
				state.error = 'Clipboard API unavailable.';
				state.message = '';
				render();
				break;
			}
			void navigator.clipboard.writeText(text)
				.then(() => {
					state.message = 'Browser companion command copied.';
					state.error = '';
					render();
				})
				.catch((error) => {
					state.error = error instanceof Error ? error.message : String(error);
					state.message = '';
					render();
				});
			break;
		}
		case 'browser-click-continue':
			void enqueueBrowserControlCommand(target.dataset.jobId || currentJob()?.jobId || '', {
				kind: 'click_continue',
				label: 'Click Continue',
			});
			break;
		case 'browser-send-future':
			{
				const browserJob = ensureJob(target.dataset.jobId || currentJob()?.jobId || '');
			void enqueueBrowserControlCommand(target.dataset.jobId || currentJob()?.jobId || '', {
				kind: 'send_prompt',
				label: 'Send Saved Future',
				prompt: state.futureInstructions.trim() || currentChatDraft(browserJob),
			});
			}
			break;
		case 'browser-auto-continue':
			{
				const browserJob = ensureJob(target.dataset.jobId || currentJob()?.jobId || '');
			void enqueueBrowserControlCommand(target.dataset.jobId || currentJob()?.jobId || '', {
				kind: 'auto_continue_run',
				label: 'Auto Continue + Send',
				prompt: state.futureInstructions.trim() || currentChatDraft(browserJob),
			});
			}
			break;
		case 'save-future-instructions':
			state.futureInstructions = state.futureInstructionsDraft;
			state.futureInstructionsSavedAt = new Date().toISOString();
			state.message = 'Future instructions saved to GPT context.';
			state.error = '';
			persistViewState();
			scheduleModelContextSync(true);
			render();
			break;
		case 'clear-future-instructions':
			state.futureInstructions = '';
			state.futureInstructionsDraft = '';
			state.futureInstructionsSavedAt = new Date().toISOString();
			state.message = 'Future instructions cleared.';
			state.error = '';
			persistViewState();
			scheduleModelContextSync(true);
			render();
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
		case 'enable-alerts':
			void requestBrowserAlertsPermission()
				.then((permission) => {
					state.message = permission === 'granted' ? 'Browser alerts enabled.' : `Browser alerts permission: ${permission}.`;
					state.error = '';
					render();
				})
				.catch((error) => {
					state.error = error instanceof Error ? error.message : String(error);
					render();
				});
			break;
		case 'save-standalone-token':
			persistStandaloneToken();
			state.utilityMenuOpen = false;
			void refreshStandaloneSession().then(() => {
				if (state.session.ready) {
					startPolling();
					void loadJobs({ silent: true, keepSection: true });
				}
			});
			break;
		case 'clear-standalone-token':
			state.utilityMenuOpen = false;
			void disconnectStandaloneBrowserLogin();
			break;
		case 'retry-standalone-session':
			state.utilityMenuOpen = false;
			void refreshStandaloneSession().then(() => {
				if (state.session.ready) {
					startPolling();
					void loadJobs({ silent: true, keepSection: true });
				}
			});
			break;
		case 'retry-auth-config':
			void refreshStandaloneAuthConfig();
			break;
		case 'begin-browser-login':
			state.utilityMenuOpen = false;
			void beginStandaloneBrowserLogin();
			break;
		case 'browser-logout':
			state.utilityMenuOpen = false;
			void disconnectStandaloneBrowserLogin();
			break;
		case 'load-demo':
			seedDemoStore();
			state.notificationMenuOpen = false;
			state.utilityMenuOpen = false;
			render();
			break;
		case 'send-chat-draft':
			void sendChatDraft();
			break;
		case 'copy-chat-draft':
			void copyChatDraft();
			break;
		case 'open-chat-ui':
			openChatUi();
			break;
		default:
			break;
	}
});

document.addEventListener('click', (event) => {
	if (!state.notificationMenuOpen && !state.utilityMenuOpen) {
		return;
	}
	const target = event.target instanceof Element ? event.target : null;
	if (target && (target.closest('[data-notification-menu]') || target.closest('[data-access-menu]'))) {
		return;
	}
	state.notificationMenuOpen = false;
	state.utilityMenuOpen = false;
	render();
});

function handleMutableInput(target) {
	if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
		return;
	}
	let shouldRerender = false;
	switch (target.name) {
		case 'approval-note':
			state.approvalNote = target.value;
			break;
		case 'control-note':
			state.controlNote = target.value;
			break;
		case 'chat-draft':
			state.chatDraft = target.value;
			break;
		case 'future-instructions':
			state.futureInstructionsDraft = target.value;
			syncFutureDraftUi();
			break;
		case 'standalone-token':
			state.standaloneToken = target.value;
			break;
		case 'dashboard-search':
			state.dashboardSearch = target.value;
			shouldRerender = true;
			break;
		case 'dashboard-status':
			state.dashboardStatus = target.value;
			shouldRerender = true;
			break;
		case 'dashboard-sort':
			state.dashboardSort = DASHBOARD_SORTS.includes(target.value) ? target.value : 'recent';
			shouldRerender = true;
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
	if (shouldRerender) {
		render();
	}
}

root.addEventListener('input', (event) => {
	handleMutableInput(event.target);
});

root.addEventListener('change', (event) => {
	handleMutableInput(event.target);
});

root.addEventListener('keydown', (event) => {
	if (event.target instanceof Element && event.target.closest('[data-action]') && !event.target.matches('[data-select-job][role="button"]')) {
		return;
	}
	const target = event.target instanceof HTMLElement ? event.target.closest('[data-select-job][role="button"]') : null;
	if (!(target instanceof HTMLElement)) return;
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	target.click();
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
		maybeEmitBrowserAlerts(sortedJobs());
	}
	render();
});

window.addEventListener('popstate', () => {
	syncRouteStateFromLocation();
	render();
});

hydrate();
void connectStandardBridge();
