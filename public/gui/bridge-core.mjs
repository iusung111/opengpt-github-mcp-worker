const DEFAULT_PROTOCOL_VERSION = '2026-01-26';
const DEFAULT_TIMEOUT_MS = 4_000;
const HOST_FONT_STYLE_ID = 'mcp-app-host-fonts';

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
	if (!hasRecord(result)) return null;
	return hasRecord(result.structuredContent) ? result.structuredContent : null;
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
	lines.push('Use this context to continue the current run or explain the next operator action.');
	return lines.join('\n');
}

function createTimeoutError(method) {
	return new Error(`${method} timed out waiting for MCP Apps host response`);
}

export function createMcpUiBridge(options = {}) {
	const win = options.win ?? globalThis.window;
	const doc = options.doc ?? globalThis.document;
	const appInfo = options.appInfo ?? { name: 'opengpt-notification-center', version: '1.0.0' };
	const appCapabilities = options.appCapabilities ?? { availableDisplayModes: ['inline', 'fullscreen'] };
	const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DEFAULT_TIMEOUT_MS;
	const parentOrigin = readParentOrigin(doc && doc.referrer ? doc.referrer : '', win && win.location ? win.location.origin : '*');
	const pending = new Map();
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
	};

	function rejectPending(id, error) {
		const deferred = pending.get(id);
		if (!deferred) return;
		pending.delete(id);
		if (deferred.timeout) {
			clearTimeout(deferred.timeout);
		}
		deferred.reject(error);
	}

	function resolvePending(id, value) {
		const deferred = pending.get(id);
		if (!deferred) return;
		pending.delete(id);
		if (deferred.timeout) {
			clearTimeout(deferred.timeout);
		}
		deferred.resolve(value);
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

	function request(method, params = {}) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => rejectPending(id, createTimeoutError(method)), requestTimeoutMs);
			pending.set(id, { resolve, reject, timeout });
			try {
				postMessage({ jsonrpc: '2.0', id, method, params });
			} catch (error) {
				rejectPending(id, error instanceof Error ? error : new Error(String(error)));
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
		if (Object.prototype.hasOwnProperty.call(data, 'id') && pending.has(data.id)) {
			if (hasRecord(data.error)) {
				const message =
					typeof data.error.message === 'string' ? data.error.message : `MCP Apps host request failed for ${String(data.id)}`;
				rejectPending(data.id, new Error(message));
				return;
			}
			resolvePending(data.id, data.result);
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
				if (typeof options.onToolInput === 'function') {
					options.onToolInput(state.toolInput, data.method);
				}
				break;
			case 'ui/notifications/tool-result':
				state.toolOutput = hasRecord(data.params) ? data.params : null;
				if (typeof options.onToolResult === 'function') {
					options.onToolResult(state.toolOutput);
				}
				break;
			case 'ui/notifications/tool-cancelled':
				if (typeof options.onToolCancelled === 'function') {
					options.onToolCancelled(hasRecord(data.params) ? data.params : null);
				}
				break;
			case 'ui/notifications/request-teardown':
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
			};
		},
		isConnected() {
			return connected;
		},
		async connect() {
			attach();
			const result = await request('ui/initialize', {
				appCapabilities,
				appInfo,
				protocolVersion: DEFAULT_PROTOCOL_VERSION,
			});
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
			return request('ui/open-link', { url });
		},
		notifySize(params) {
			notify('ui/notifications/size-changed', params);
		},
		destroy() {
			detach();
			connected = false;
			for (const id of Array.from(pending.keys())) {
				rejectPending(id, new Error('MCP Apps bridge destroyed'));
			}
		},
	};
}
