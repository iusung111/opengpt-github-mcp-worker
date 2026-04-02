import type { RunAttentionStatus } from './common';

export const WEB_SESSION_PROVIDERS = ['chatgpt_web'] as const;
export type WebSessionProvider = (typeof WEB_SESSION_PROVIDERS)[number];

export const WEB_SESSION_AUTH_STATES = [
	'unknown',
	'authenticated',
	'approval_required',
	'login_required',
	'expired',
	'blocked',
] as const;
export type WebSessionAuthState = (typeof WEB_SESSION_AUTH_STATES)[number];

export const WEB_SESSION_APPROVAL_STATES = ['none', 'pending', 'granted', 'rejected'] as const;
export type WebSessionApprovalState = (typeof WEB_SESSION_APPROVAL_STATES)[number];

export const WEB_SESSION_FOLLOWUP_STATES = [
	'unknown',
	'ready',
	'cooldown',
	'requires_focus',
	'not_available',
] as const;
export type WebSessionFollowupState = (typeof WEB_SESSION_FOLLOWUP_STATES)[number];

export interface JobWebSessionContext {
	provider: WebSessionProvider;
	session_url: string;
	canonical_conversation_url?: string | null;
	conversation_id?: string | null;
	page_url_at_attach?: string | null;
	page_title_at_attach?: string | null;
	auth_state: WebSessionAuthState;
	approval_state: WebSessionApprovalState;
	followup_state: WebSessionFollowupState;
	can_send_followup?: boolean | null;
	last_user_visible_action?: string | null;
	last_prompt_digest?: string | null;
	last_followup_at?: string | null;
	linked_job_url?: string | null;
	updated_at?: string | null;
}

export const BROWSER_REMOTE_COMMAND_KINDS = [
	'click_continue',
	'send_prompt',
	'auto_continue_run',
	'resolve_permission_prompt',
	'send_followup',
] as const;
export type BrowserRemoteCommandKind = (typeof BROWSER_REMOTE_COMMAND_KINDS)[number];
export type BrowserRemoteCommandStatus = 'pending' | 'claimed';
export type BrowserRemoteSessionStatus = 'connected' | 'stale' | 'disconnected';

export interface JobBrowserRemoteSession {
	session_id: string;
	agent_name: string | null;
	mode: 'chatgpt_cdp_attach';
	status: BrowserRemoteSessionStatus;
	connected_at: string;
	last_seen_at: string;
	page_url?: string | null;
	page_title?: string | null;
	browser_name?: string | null;
	cdp_origin?: string | null;
}

export interface JobBrowserRemoteCommand {
	command_id: string;
	kind: BrowserRemoteCommandKind;
	status: BrowserRemoteCommandStatus;
	job_id?: string | null;
	job_title?: string | null;
	repo?: string | null;
	run_status?: RunAttentionStatus | null;
	label?: string | null;
	prompt?: string | null;
	page_url_hint?: string | null;
	created_at: string;
	created_by?: string | null;
	claimed_at?: string | null;
	claimed_by?: string | null;
}

export interface JobBrowserRemoteCommandResult {
	command_id: string;
	kind: BrowserRemoteCommandKind;
	ok: boolean;
	job_id?: string | null;
	job_title?: string | null;
	repo?: string | null;
	run_status?: RunAttentionStatus | null;
	summary: string | null;
	error?: string | null;
	matched_actions?: string[];
	page_url?: string | null;
	page_title?: string | null;
	completed_at: string;
}

export interface BrowserRemoteActiveJob {
	job_id: string;
	job_title?: string | null;
	repo?: string | null;
	run_status?: RunAttentionStatus | null;
}

export interface JobBrowserRemoteControlState {
	session?: JobBrowserRemoteSession | null;
	active_job?: BrowserRemoteActiveJob | null;
	pending_command?: JobBrowserRemoteCommand | null;
	last_result?: JobBrowserRemoteCommandResult | null;
}

export interface JobBrowserManifest {
	status?: 'idle' | 'running' | 'passed' | 'failed' | null;
	session_id?: string | null;
	target?: string | null;
	artifacts?: string[];
	remote_control?: JobBrowserRemoteControlState | null;
	session_context?: JobWebSessionContext | null;
	updated_at?: string;
}
