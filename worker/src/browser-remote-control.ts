import {
	BrowserRemoteCommandKind,
	JobBrowserRemoteCommand,
	JobBrowserRemoteCommandResult,
	JobBrowserRemoteControlState,
	JobBrowserRemoteSession,
} from './types';
import { nowIso, parseIsoMs } from './utils';

const DEFAULT_STALE_AFTER_MS = 45_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCommandKind(value: unknown): BrowserRemoteCommandKind | null {
	return value === 'click_continue' || value === 'send_prompt' || value === 'auto_continue_run' ? value : null;
}

function normalizeCommandStatus(value: unknown): 'pending' | 'claimed' {
	return value === 'claimed' ? 'claimed' : 'pending';
}

function normalizeSessionStatus(value: unknown): 'connected' | 'stale' | 'disconnected' {
	if (value === 'disconnected') return 'disconnected';
	if (value === 'stale') return 'stale';
	return 'connected';
}

function normalizeSession(value: unknown, nowMs: number, staleAfterMs: number): JobBrowserRemoteSession | null {
	if (!isRecord(value)) return null;
	const sessionId = normalizeString(value.session_id);
	const connectedAt = normalizeString(value.connected_at);
	const lastSeenAt = normalizeString(value.last_seen_at);
	if (!sessionId || !connectedAt || !lastSeenAt) return null;
	const lastSeenMs = parseIsoMs(lastSeenAt);
	const stale = lastSeenMs !== null && nowMs - lastSeenMs > staleAfterMs;
	const storedStatus = normalizeSessionStatus(value.status);
	return {
		session_id: sessionId,
		agent_name: normalizeString(value.agent_name),
		mode: 'chatgpt_cdp_attach',
		status: storedStatus === 'disconnected' ? 'disconnected' : stale ? 'stale' : 'connected',
		connected_at: connectedAt,
		last_seen_at: lastSeenAt,
		page_url: normalizeString(value.page_url),
		page_title: normalizeString(value.page_title),
		browser_name: normalizeString(value.browser_name),
		cdp_origin: normalizeString(value.cdp_origin),
	};
}

function normalizeCommand(value: unknown): JobBrowserRemoteCommand | null {
	if (!isRecord(value)) return null;
	const commandId = normalizeString(value.command_id);
	const kind = normalizeCommandKind(value.kind);
	const createdAt = normalizeString(value.created_at);
	if (!commandId || !kind || !createdAt) return null;
	return {
		command_id: commandId,
		kind,
		status: normalizeCommandStatus(value.status),
		label: normalizeString(value.label),
		prompt: normalizeString(value.prompt),
		page_url_hint: normalizeString(value.page_url_hint),
		created_at: createdAt,
		created_by: normalizeString(value.created_by),
		claimed_at: normalizeString(value.claimed_at),
		claimed_by: normalizeString(value.claimed_by),
	};
}

function normalizeResult(value: unknown): JobBrowserRemoteCommandResult | null {
	if (!isRecord(value)) return null;
	const commandId = normalizeString(value.command_id);
	const kind = normalizeCommandKind(value.kind);
	const completedAt = normalizeString(value.completed_at);
	if (!commandId || !kind || !completedAt) return null;
	return {
		command_id: commandId,
		kind,
		ok: value.ok === true,
		summary: normalizeString(value.summary),
		error: normalizeString(value.error),
		matched_actions: Array.isArray(value.matched_actions) ? value.matched_actions.map((item) => String(item)) : [],
		page_url: normalizeString(value.page_url),
		page_title: normalizeString(value.page_title),
		completed_at: completedAt,
	};
}

export function normalizeBrowserRemoteControl(
	value: unknown,
	options: { nowMs?: number; staleAfterMs?: number } = {},
): JobBrowserRemoteControlState | null {
	if (!isRecord(value)) return null;
	const nowMs = options.nowMs ?? Date.now();
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
	const session = normalizeSession(value.session, nowMs, staleAfterMs);
	const pendingCommand = normalizeCommand(value.pending_command);
	const lastResult = normalizeResult(value.last_result);
	if (!session && !pendingCommand && !lastResult) return null;
	return {
		session,
		pending_command: pendingCommand,
		last_result: lastResult,
	};
}

export function browserRemoteSessionConnected(value: unknown, options: { nowMs?: number; staleAfterMs?: number } = {}): boolean {
	const control = normalizeBrowserRemoteControl(value, options);
	return Boolean(control?.session && control.session.status === 'connected');
}

export function upsertBrowserRemoteSession(
	current: unknown,
	input: {
		session_id?: string | null;
		agent_name?: string | null;
		page_url?: string | null;
		page_title?: string | null;
		browser_name?: string | null;
		cdp_origin?: string | null;
	},
	timestamp = nowIso(),
): JobBrowserRemoteControlState {
	const control = normalizeBrowserRemoteControl(current) ?? {};
	const previousSession = control.session ?? null;
	return {
		...control,
		session: {
			session_id: normalizeString(input.session_id) ?? previousSession?.session_id ?? crypto.randomUUID(),
			agent_name: normalizeString(input.agent_name) ?? previousSession?.agent_name ?? null,
			mode: 'chatgpt_cdp_attach',
			status: 'connected',
			connected_at: previousSession?.connected_at ?? timestamp,
			last_seen_at: timestamp,
			page_url: normalizeString(input.page_url) ?? previousSession?.page_url ?? null,
			page_title: normalizeString(input.page_title) ?? previousSession?.page_title ?? null,
			browser_name: normalizeString(input.browser_name) ?? previousSession?.browser_name ?? null,
			cdp_origin: normalizeString(input.cdp_origin) ?? previousSession?.cdp_origin ?? null,
		},
	};
}

export function disconnectBrowserRemoteSession(current: unknown, timestamp = nowIso()): JobBrowserRemoteControlState {
	const control = normalizeBrowserRemoteControl(current) ?? {};
	if (!control.session) return control;
	return {
		...control,
		session: {
			...control.session,
			status: 'disconnected',
			last_seen_at: timestamp,
		},
	};
}

export function enqueueBrowserRemoteCommand(
	current: unknown,
	input: {
		kind: BrowserRemoteCommandKind;
		label?: string | null;
		prompt?: string | null;
		page_url_hint?: string | null;
		created_by?: string | null;
	},
	timestamp = nowIso(),
): JobBrowserRemoteControlState {
	const control = normalizeBrowserRemoteControl(current) ?? {};
	if (control.pending_command && (control.pending_command.status === 'pending' || control.pending_command.status === 'claimed')) {
		throw new Error('A browser control command is already pending for this run.');
	}
	return {
		...control,
		pending_command: {
			command_id: crypto.randomUUID(),
			kind: input.kind,
			status: 'pending',
			label: normalizeString(input.label),
			prompt: normalizeString(input.prompt),
			page_url_hint: normalizeString(input.page_url_hint),
			created_at: timestamp,
			created_by: normalizeString(input.created_by),
			claimed_at: null,
			claimed_by: null,
		},
	};
}

export function claimBrowserRemoteCommand(
	current: unknown,
	input: { session_id: string },
	timestamp = nowIso(),
): { control: JobBrowserRemoteControlState; command: JobBrowserRemoteCommand | null } {
	const control = normalizeBrowserRemoteControl(current) ?? {};
	const pendingCommand = control.pending_command;
	if (!pendingCommand) {
		return { control, command: null };
	}
	if (pendingCommand.status === 'claimed' && pendingCommand.claimed_by && pendingCommand.claimed_by !== input.session_id) {
		return { control, command: null };
	}
	const claimedCommand: JobBrowserRemoteCommand = {
		...pendingCommand,
		status: 'claimed',
		claimed_at: timestamp,
		claimed_by: input.session_id,
	};
	return {
		control: {
			...control,
			pending_command: claimedCommand,
		},
		command: claimedCommand,
	};
}

export function completeBrowserRemoteCommand(
	current: unknown,
	input: {
		command_id: string;
		ok: boolean;
		summary?: string | null;
		error?: string | null;
		matched_actions?: string[];
		page_url?: string | null;
		page_title?: string | null;
	},
	timestamp = nowIso(),
): JobBrowserRemoteControlState {
	const control = normalizeBrowserRemoteControl(current) ?? {};
	const pendingCommand = control.pending_command;
	if (!pendingCommand || pendingCommand.command_id !== input.command_id) {
		throw new Error('The browser control command could not be matched to the pending run state.');
	}
	return {
		...control,
		pending_command: null,
		last_result: {
			command_id: pendingCommand.command_id,
			kind: pendingCommand.kind,
			ok: input.ok === true,
			summary: normalizeString(input.summary),
			error: normalizeString(input.error),
			matched_actions: Array.isArray(input.matched_actions) ? input.matched_actions.map((item) => String(item)) : [],
			page_url: normalizeString(input.page_url),
			page_title: normalizeString(input.page_title),
			completed_at: timestamp,
		},
	};
}
