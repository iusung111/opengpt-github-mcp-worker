const DEFAULT_PROTOCOL_VERSION = '2026-01-26';
const DEFAULT_INITIALIZE_TIMEOUT_MS = 4_000;
const DEFAULT_EXECUTION_SOFT_TIMEOUT_MS = 8_000;
const DEFAULT_EXECUTION_HARD_TIMEOUT_MS = 120_000;
const HOST_FONT_STYLE_ID = 'mcp-app-host-fonts';
const EXECUTION_METHODS = new Set(['tools/call', 'ui/message', 'ui/update-model-context']);
const HOST_CAPABILITY_KEYS = {
	'ui/message': ['message', 'messages', 'chat'],
	'ui/update-model-context': ['modelContext', 'context', 'widgetState'],
	'ui/open-link': ['openLink', 'links', 'browser'],
	'ui/notifications/size-changed': ['size', 'layout', 'resize'],
};

export function hasRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readParentOrigin(referrer, fallbackOrigin = '*') {
	if (typeof referrer === 'string' && referrer.trim()) {
		try {
			return new URL(referrer).origin;
		} catch {
			return fallbackOrigin;
		}
	}
	return fallbackOrigin;
}

export function extractStructuredResult(result) {
	const extracted = extractToolResultEnvelope(result);
	return extracted ? extracted.structuredContent : null;
}

export function extractToolResultEnvelope(result) {
	if (!hasRecord(result)) return null;
	const payload = hasRecord(result.result) ? result.result : result;
	return {
		structuredContent: hasRecord(payload.structuredContent) ? payload.structuredContent : null,
		meta: hasRecord(payload._meta) ? payload._meta : null,
	};
}

function setDatasetValue(dataset, key, value) {
	if (!dataset) return;
	if (value == null || value === '') {
		try {
			delete dataset[key];
		} catch {
			dataset[key] = '';
		}
		return;
	}
	dataset[key] = String(value);
}

function applyFontCss(doc, cssText) {
	if (!doc || !doc.head || typeof doc.createElement !== 'function') return;
	const existing = typeof doc.getElementById === 'function' ? doc.getElementById(HOST_FONT_STYLE_ID) : null;
	if (!cssText) {
		if (existing && typeof existing.remove === 'function') {
			existing.remove();
		}
		return;
	}
	const styleNode = existing || doc.createElement('style');
	styleNode.id = HOST_FONT_STYLE_ID;
	styleNode.textContent = cssText;
	if (!existing && typeof doc.head.appendChild === 'function') {
		doc.head.appendChild(styleNode);
	}
}

export function applyHostContextToDocument(hostContext, doc = globalThis.document) {
	if (!hasRecord(hostContext) || !doc || !doc.documentElement) return;
	const root = doc.documentElement;
	const style = root.style;
	setDatasetValue(root.dataset, 'theme', hostContext.theme);
	setDatasetValue(root.dataset, 'platform', hostContext.platform);
	setDatasetValue(root.dataset, 'displayMode', hostContext.displayMode);
	if (style && typeof style.setProperty === 'function') {
		if (hostContext.theme) {
			style.setProperty('color-scheme', String(hostContext.theme));
		}
		const variables = hasRecord(hostContext.styles) && hasRecord(hostContext.styles.variables) ? hostContext.styles.variables : null;
		if (variables) {
			for (const [key, value] of Object.entries(variables)) {
				if (typeof value === 'string' || typeof value === 'number') {
					style.setProperty(key, String(value));
				}
			}
		}
		const safeAreaInsets = hasRecord(hostContext.safeAreaInsets) ? hostContext.safeAreaInsets : null;
		for (const inset of ['top', 'right', 'bottom', 'left']) {
			const rawValue = safeAreaInsets && typeof safeAreaInsets[inset] === 'number' ? safeAreaInsets[inset] : 0;
			style.setProperty(`--safe-area-inset-${inset}`, `${rawValue}px`);
		}
	}
	const cssFonts =
		hasRecord(hostContext.styles) && hasRecord(hostContext.styles.css) && typeof hostContext.styles.css.fonts === 'string'
			? hostContext.styles.css.fonts
			: '';
	applyFontCss(doc, cssFonts);
}

export function buildModelContextText(snapshot) {
	const lines = ['---'];
	const mappings = [
		['job-id', snapshot.job_id],
		['repo', snapshot.repo],
		['tab', snapshot.tab],
		['payload-kind', snapshot.payload_kind],
		['status', snapshot.run_summary && snapshot.run_summary.status],
		['display-mode', snapshot.host && snapshot.host.display_mode],
		['platform', snapshot.host && snapshot.host.platform],
		['theme', snapshot.host && snapshot.host.theme],
	];
	for (const [key, value] of mappings) {
		if (value != null && value !== '') {
			lines.push(`${key}: ${String(value)}`);
		}
	}
	lines.push('---');
	if (snapshot.run_summary && snapshot.run_summary.title) {
		lines.push(`Run title: ${snapshot.run_summary.title}`);
	}
	if (snapshot.run_summary && snapshot.run_summary.last_event) {
		lines.push(`Latest run event: ${snapshot.run_summary.last_event}`);
	}
	if (snapshot.run_summary && snapshot.run_summary.control_state) {
		lines.push(`Control state: ${snapshot.run_summary.control_state}`);
	}
	if (snapshot.run_summary && snapshot.run_summary.interrupt_kind) {
		lines.push(`Interrupt kind: ${snapshot.run_summary.interrupt_kind}`);
	}
	if (snapshot.run_summary && snapshot.run_summary.interrupt_message) {
		lines.push(`Interrupt detail: ${snapshot.run_summary.interrupt_message}`);
	}
	if (snapshot.blocking_state && snapshot.blocking_state.kind && snapshot.blocking_state.kind !== 'none') {
		lines.push(`Blocking state: ${snapshot.blocking_state.kind}`);
		if (snapshot.blocking_state.reason) {
			lines.push(`Blocking reason: ${snapshot.blocking_state.reason}`);
		}
		if (snapshot.blocking_state.blocked_action) {
			lines.push(`Blocked action: ${snapshot.blocking_state.blocked_action}`);
		}
	}
	if (snapshot.latest_notification && snapshot.latest_notification.title) {
		lines.push(`Latest notification: ${snapshot.latest_notification.title}`);
	}
	if (snapshot.latest_notification && snapshot.latest_notification.body) {
		lines.push(`Notification detail: ${snapshot.latest_notification.body}`);
	}
	if (snapshot.permission_bundle && snapshot.permission_bundle.status) {
		lines.push(`Permission bundle status: ${snapshot.permission_bundle.status}`);
	}
	if (snapshot.permission_bundle && snapshot.permission_bundle.request_id) {
		lines.push(`Permission request id: ${snapshot.permission_bundle.request_id}`);
	}
	const permissionBundle =
		hasRecord(snapshot.permission_bundle) && hasRecord(snapshot.permission_bundle.bundle)
			? snapshot.permission_bundle.bundle
			: null;
	if (permissionBundle && Array.isArray(permissionBundle.repos) && permissionBundle.repos.length) {
		lines.push(`Permission scope: ${permissionBundle.repos.join(', ')}`);
	}
	if (
		permissionBundle &&
		typeof permissionBundle.approval_request === 'string' &&
		permissionBundle.approval_request
	) {
		lines.push(`Approval request: ${permissionBundle.approval_request}`);
	}
	if (hasRecord(snapshot.latest_tool_session)) {
		if (snapshot.latest_tool_session.request_id) {
			lines.push(`Latest tool request: ${snapshot.latest_tool_session.request_id}`);
		}
		if (snapshot.latest_tool_session.tool_name) {
			lines.push(`Latest tool name: ${snapshot.latest_tool_session.tool_name}`);
		}
		if (snapshot.latest_tool_session.phase) {
			lines.push(`Latest tool phase: ${snapshot.latest_tool_session.phase}`);
		}
		if (snapshot.latest_tool_session.next_step) {
			lines.push(`Latest tool next step: ${snapshot.latest_tool_session.next_step}`);
		}
	}
	lines.push('Use this context to continue the current run or explain the next operator action.');
	return lines.join('\n');
}

function createTimeoutError(method, phase) {
	return new Error(`${method} ${phase} waiting for MCP Apps host response`);
}

function createCapabilityError(method) {
	return new Error(`MCP Apps host does not advertise ${method} support`);
}

function capabilityEnabled(value) {
	if (value === true) return true;
	if (value === false) return false;
	return hasRecord(value);
}

function extractRequestId(value) {
	if (!hasRecord(value)) return null;
	if (typeof value.request_id === 'string' || typeof value.request_id === 'number') {
		return String(value.request_id);
	}
	if (typeof value.requestId === 'string' || typeof value.requestId === 'number') {
		return String(value.requestId);
	}
	if (typeof value.id === 'string' || typeof value.id === 'number') {
		return String(value.id);
	}
	if (hasRecord(value.request)) {
		return extractRequestId(value.request);
	}
	return null;
}

function toolResultKind(value) {
	const extracted = extractToolResultEnvelope(value);
	return extracted && extracted.structuredContent && typeof extracted.structuredContent.kind === 'string'
		? extracted.structuredContent.kind
		: null;
}

function nextStepForSession(session) {
	if (session.phase === 'pending') {
		return 'Waiting for the host to acknowledge the request.';
	}
	if (session.phase === 'waiting') {
		return 'The host is still processing the request. Keep the widget open.';
	}
	if (session.phase === 'completed') {
		if (session.method === 'ui/message') return 'Check the host conversation for the sent message.';
		if (session.method === 'ui/update-model-context') return 'Send the next instruction or tool call.';
		return 'Inspect the tool result and decide the next operator action.';
	}
	if (session.phase === 'cancelled') {
		return 'Decide whether to retry, resume, or leave the run paused.';
	}
	if (session.phase === 'timed_out') {
		return 'Retry the request or inspect host connectivity.';
	}
	return 'Inspect the error and decide whether to retry.';
}

export function createMcpUiBridge(options = {}) {
	const win = options.win ?? globalThis.window;
	const doc = options.doc ?? globalThis.document;
	const appInfo = options.appInfo ?? { name: 'opengpt-notification-center', version: '1.0.0' };
	const appCapabilities = options.appCapabilities ?? { availableDisplayModes: ['inline', 'fullscreen'] };
	const initializeTimeoutMs = Number.isFinite(options.initializeTimeoutMs)
		? options.initializeTimeoutMs
		: DEFAULT_INITIALIZE_TIMEOUT_MS;
	const executionSoftTimeoutMs = Number.isFinite(options.executionSoftTimeoutMs)
		? options.executionSoftTimeoutMs
		: DEFAULT_EXECUTION_SOFT_TIMEOUT_MS;
	const executionHardTimeoutMs = Number.isFinite(options.executionHardTimeoutMs)
		? options.executionHardTimeoutMs
		: DEFAULT_EXECUTION_HARD_TIMEOUT_MS;
	const parentOrigin = readParentOrigin(doc && doc.referrer ? doc.referrer : '', win && win.location ? win.location.origin : '*');
	const pending = new Map();
	const sessionMap = new Map();
	let nextId = 1;
	let connected = false;
	let listenerAttached = false;
	const state = {
		parentOrigin,
		hostCapabilities: null,
		hostContext: null,
		hostInfo: null,
		protocolVersion: null,
		toolInput: null,
		toolOutput: null,
		toolSessions: [],
	};

	function emitSession(session) {
		sessionMap.set(session.requestId, { ...session });
		state.toolSessions = Array.from(sessionMap.values()).sort((left, right) =>
			String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')),
		);
		if (typeof options.onRequestStateChanged === 'function') {
			options.onRequestStateChanged({ ...session });
		}
	}

	function upsertSession(id, patch = {}) {
		const requestId = String(id);
		const existing = sessionMap.get(requestId) ?? {
			requestId,
			method: '',
			toolName: '',
			args: {},
			phase: 'pending',
			nextStep: '',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			resultKind: null,
			error: null,
			jobId: null,
		};
		const session = {
			...existing,
			...patch,
			requestId,
			args: hasRecord(patch.args) ? patch.args : existing.args,
			updatedAt: patch.updatedAt ?? new Date().toISOString(),
		};
		session.nextStep = nextStepForSession(session);
		emitSession(session);
		return session;
	}

	function rejectPending(id, error, phase = 'failed') {
		const requestId = String(id);
		const deferred = pending.get(requestId);
		if (deferred) {
			pending.delete(requestId);
			if (deferred.softTimeout) {
				clearTimeout(deferred.softTimeout);
			}
			if (deferred.hardTimeout) {
				clearTimeout(deferred.hardTimeout);
			}
			deferred.reject(error);
		}
		upsertSession(requestId, {
			phase,
			error: error instanceof Error ? error.message : String(error),
			resultKind: null,
		});
	}

	function resolvePending(id, value, patch = {}) {
		const requestId = String(id);
		const deferred = pending.get(requestId);
		if (deferred) {
			pending.delete(requestId);
			if (deferred.softTimeout) {
				clearTimeout(deferred.softTimeout);
			}
			if (deferred.hardTimeout) {
				clearTimeout(deferred.hardTimeout);
			}
			deferred.resolve(value);
		}
		upsertSession(requestId, {
			phase: patch.phase ?? 'completed',
			resultKind: patch.resultKind ?? toolResultKind(value),
			error: null,
		});
	}

	function isRpcEnvelope(data) {
		return hasRecord(data) && data.jsonrpc === '2.0';
	}

	function postMessage(payload) {
		if (!win || !win.parent || win.parent === win || typeof win.parent.postMessage !== 'function') {
			throw new Error('MCP Apps host bridge is unavailable');
		}
		win.parent.postMessage(payload, parentOrigin);
	}

	function notify(method, params = {}) {
		postMessage({ jsonrpc: '2.0', method, params });
	}

	function supports(method) {
		if (method === 'tools/call') {
			return connected || method === 'tools/call';
		}
		if (!connected) return false;
		if (!hasRecord(state.hostCapabilities)) return true;
		const capabilityKeys = HOST_CAPABILITY_KEYS[method] ?? [];
		const explicitKeys = capabilityKeys.filter((key) => Object.prototype.hasOwnProperty.call(state.hostCapabilities, key));
		if (!explicitKeys.length) return true;
		return explicitKeys.some((key) => capabilityEnabled(state.hostCapabilities[key]));
	}

	function correlateSessionId(params) {
		const explicitId = extractRequestId(params);
		if (explicitId) {
			return explicitId;
		}
		const candidates = state.toolSessions.filter(
			(session) =>
				session.method === 'tools/call' && (session.phase === 'pending' || session.phase === 'waiting'),
		);
		if (candidates.length === 1) {
			return candidates[0].requestId;
		}
		return candidates[0]?.requestId ?? null;
	}

	function request(method, params = {}, requestOptions = {}) {
		if (connected && !supports(method)) {
			return Promise.reject(createCapabilityError(method));
		}
		const id = nextId++;
		const isExecutionMethod = EXECUTION_METHODS.has(method);
		const hardTimeoutMs = Number.isFinite(requestOptions.hardTimeoutMs)
			? requestOptions.hardTimeoutMs
			: isExecutionMethod
				? executionHardTimeoutMs
				: initializeTimeoutMs;
		const softTimeoutMs = Number.isFinite(requestOptions.softTimeoutMs)
			? requestOptions.softTimeoutMs
			: isExecutionMethod
				? executionSoftTimeoutMs
				: 0;
		const session =
			requestOptions.trackSession === false
				? null
				: upsertSession(id, {
						method,
						toolName: method === 'tools/call' ? String(params.name || 'tool') : method,
						args:
							method === 'tools/call' && hasRecord(params.arguments)
								? params.arguments
								: hasRecord(params)
									? params
									: {},
						phase: 'pending',
						resultKind: null,
						error: null,
				  });
		return new Promise((resolve, reject) => {
			const requestId = String(id);
			const softTimeout =
				softTimeoutMs > 0
					? setTimeout(() => {
							if (!pending.has(requestId)) return;
							upsertSession(requestId, { phase: 'waiting' });
							if (typeof options.onSoftTimeout === 'function') {
								options.onSoftTimeout(session ?? sessionMap.get(String(id)) ?? null);
							}
					  }, softTimeoutMs)
					: null;
			const hardTimeout = setTimeout(
				() => rejectPending(requestId, createTimeoutError(method, 'timed out'), 'timed_out'),
				hardTimeoutMs,
			);
			pending.set(requestId, { resolve, reject, softTimeout, hardTimeout });
			try {
				postMessage({ jsonrpc: '2.0', id, method, params });
			} catch (error) {
				rejectPending(requestId, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	function handleHostContext(hostContext, result = null) {
		state.hostContext = hasRecord(hostContext) ? hostContext : null;
		if (hasRecord(result)) {
			state.hostCapabilities = hasRecord(result.hostCapabilities) ? result.hostCapabilities : state.hostCapabilities;
			state.hostInfo = hasRecord(result.hostInfo) ? result.hostInfo : state.hostInfo;
			state.protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : state.protocolVersion;
		}
		if (typeof options.onHostContextChanged === 'function') {
			options.onHostContextChanged(state.hostContext, result);
		}
	}

	function onMessage(event) {
		if (!win || event.source !== win.parent) return;
		if (parentOrigin !== '*' && event.origin && event.origin !== parentOrigin) return;
		const data = event.data;
		if (!isRpcEnvelope(data)) return;
		if (Object.prototype.hasOwnProperty.call(data, 'id') && pending.has(String(data.id))) {
			if (hasRecord(data.error)) {
				const message =
					typeof data.error.message === 'string' ? data.error.message : `MCP Apps host request failed for ${String(data.id)}`;
				rejectPending(String(data.id), new Error(message));
				return;
			}
			resolvePending(String(data.id), data.result, {
				resultKind: toolResultKind(data.result),
			});
			return;
		}
		if (typeof data.method !== 'string') return;
		switch (data.method) {
			case 'ui/notifications/host-context-changed':
				handleHostContext(data.params, null);
				break;
			case 'ui/notifications/tool-input':
			case 'ui/notifications/tool-input-partial':
				state.toolInput = hasRecord(data.params) ? data.params : null;
				{
					const sessionId = correlateSessionId(state.toolInput);
					if (sessionId) {
						upsertSession(sessionId, {
							args:
								hasRecord(state.toolInput) && hasRecord(state.toolInput.arguments)
									? state.toolInput.arguments
									: {},
						});
					}
				}
				if (typeof options.onToolInput === 'function') {
					options.onToolInput(state.toolInput, data.method);
				}
				break;
			case 'ui/notifications/tool-result':
				state.toolOutput = hasRecord(data.params) ? data.params : null;
				{
					const sessionId = correlateSessionId(state.toolOutput);
					if (sessionId) {
						resolvePending(sessionId, state.toolOutput, {
							resultKind: toolResultKind(state.toolOutput),
						});
					}
					if (typeof options.onToolResult === 'function') {
						options.onToolResult(state.toolOutput, sessionId);
					}
				}
				break;
			case 'ui/notifications/tool-cancelled':
				{
					const sessionId = correlateSessionId(hasRecord(data.params) ? data.params : null);
					if (sessionId) {
						rejectPending(sessionId, new Error('Host cancelled the current tool execution.'), 'cancelled');
					}
					if (typeof options.onToolCancelled === 'function') {
						options.onToolCancelled(hasRecord(data.params) ? data.params : null, sessionId);
					}
				}
				break;
			case 'ui/notifications/request-teardown':
				for (const id of Array.from(pending.keys())) {
					rejectPending(id, new Error('Host requested widget teardown.'), 'cancelled');
				}
				if (typeof options.onRequestTeardown === 'function') {
					options.onRequestTeardown(hasRecord(data.params) ? data.params : null);
				}
				break;
			default:
				break;
		}
	}

	function attach() {
		if (!win || listenerAttached || typeof win.addEventListener !== 'function') return;
		win.addEventListener('message', onMessage);
		listenerAttached = true;
	}

	function detach() {
		if (!win || !listenerAttached || typeof win.removeEventListener !== 'function') return;
		win.removeEventListener('message', onMessage);
		listenerAttached = false;
	}

	return {
		getState() {
			return {
				connected,
				parentOrigin,
				hostCapabilities: state.hostCapabilities,
				hostContext: state.hostContext,
				hostInfo: state.hostInfo,
				protocolVersion: state.protocolVersion,
				toolInput: state.toolInput,
				toolOutput: state.toolOutput,
				toolSessions: state.toolSessions.slice(),
			};
		},
		isConnected() {
			return connected;
		},
		supports(method) {
			if (method === 'tools/call') {
				return connected;
			}
			return supports(method);
		},
		async connect() {
			attach();
			const result = await request('ui/initialize', {
				appCapabilities,
				appInfo,
				protocolVersion: DEFAULT_PROTOCOL_VERSION,
			}, { trackSession: false, hardTimeoutMs: initializeTimeoutMs, softTimeoutMs: 0 });
			if (hasRecord(result)) {
				handleHostContext(result.hostContext, result);
			}
			notify('ui/notifications/initialized', {});
			connected = true;
			return this.getState();
		},
		callTool(name, args = {}) {
			return request('tools/call', { name, arguments: args });
		},
		sendMessage(text) {
			return request('ui/message', {
				role: 'user',
				content: [{ type: 'text', text }],
			});
		},
		updateModelContext(params) {
			return request('ui/update-model-context', params);
		},
		openLink(url) {
			if (!supports('ui/open-link')) {
				return Promise.reject(createCapabilityError('ui/open-link'));
			}
			return request('ui/open-link', { url });
		},
		notifySize(params) {
			if (supports('ui/notifications/size-changed')) {
				notify('ui/notifications/size-changed', params);
			}
		},
		destroy() {
			detach();
			connected = false;
			for (const id of Array.from(pending.keys())) {
				rejectPending(id, new Error('MCP Apps bridge destroyed'), 'cancelled');
			}
		},
	};
}
