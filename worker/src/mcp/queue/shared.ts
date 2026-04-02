import * as z from 'zod/v4';
import {
	type JobWorkerManifest,
	type WebSessionApprovalState,
	type WebSessionAuthState,
	type WebSessionFollowupState,
	WEB_SESSION_AUTH_STATES,
} from '../../contracts';
import { createEmptyWorkerManifest } from '../../job-manifest';
import { notificationWidgetToolMeta } from '../../mcp-widget-resources';
import { nowIso } from '../../utils';

const attentionStatusSchema = z.enum([
	'idle',
	'pending_approval',
	'running',
	'paused',
	'cancelled',
	'interrupted',
	'completed',
	'failed',
]);
const sourceLayerSchema = z.enum(['gpt', 'mcp', 'cloudflare', 'repo', 'system']);
const notificationCountsSchema = z
	.object({
		idle: z.number(),
		pending_approval: z.number(),
		running: z.number(),
		paused: z.number(),
		cancelled: z.number(),
		interrupted: z.number(),
		completed: z.number(),
		failed: z.number(),
	})
	.passthrough();
const runSummarySchema = z
	.object({
		run_id: z.string(),
		job_id: z.string().optional(),
		status: attentionStatusSchema,
	})
	.passthrough();
const blockingStateSchema = z
	.object({
		kind: z.enum(['none', 'approval', 'review', 'failure', 'paused', 'cancelled', 'interrupted']),
		reason: z.string().nullable().optional(),
		blocked_action: z.string().nullable().optional(),
		resume_hint: z.string().nullable().optional(),
	})
	.passthrough();
const notificationItemSchema = z
	.object({
		id: z.string(),
		job_id: z.string(),
		run_id: z.string(),
		status: attentionStatusSchema,
		source_layer: sourceLayerSchema,
	})
	.passthrough();
const layerLogEntrySchema = z
	.object({
		id: z.string(),
		job_id: z.string(),
		run_id: z.string(),
		source_layer: sourceLayerSchema,
		level: z.enum(['info', 'warning', 'error']),
	})
	.passthrough();

export const notificationReadMeta = notificationWidgetToolMeta({
	'openai/toolInvocation/invoking': 'Loading run status',
	'openai/toolInvocation/invoked': 'Run status ready',
});

export const jobProgressStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.job_progress'),
		action: z.string().optional(),
		progress: z
			.object({
				job_id: z.string(),
				run_summary: runSummarySchema,
				blocking_state: blockingStateSchema.optional(),
				latest_notification: notificationItemSchema.nullable().optional(),
				notification_counts: notificationCountsSchema.optional(),
			})
			.passthrough(),
		run_summary: runSummarySchema,
		blocking_state: blockingStateSchema.optional(),
		latest_notification: notificationItemSchema.nullable().optional(),
		notification_counts: notificationCountsSchema.optional(),
		resume_strategy: z.string().optional(),
		workflow_cancel: z.object({}).passthrough().nullable().optional(),
	})
	.passthrough();

export const jobsListStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.jobs_list'),
		jobs: z.array(
			z
				.object({
					job_id: z.string(),
					run_summary: runSummarySchema.optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export const jobEventFeedStructuredSchema = z
	.object({
		kind: z.literal('opengpt.notification_contract.job_event_feed'),
		items: z.array(notificationItemSchema),
		logs: z.array(layerLogEntrySchema),
		counts: notificationCountsSchema,
	})
	.passthrough();

export const reviewFindingSchema = z.object({
	severity: z.enum(['low', 'medium', 'high', 'critical']),
	file: z.string().min(1),
	line_hint: z.string().optional(),
	summary: z.string().min(1),
	rationale: z.string().min(1),
	required_fix: z.string().optional(),
});

export const browserSessionSeedSchema = z.object({
	provider: z.literal('chatgpt_web'),
	session_url: z.string().min(1),
	canonical_conversation_url: z.string().optional(),
	conversation_id: z.string().optional(),
	auth_state: z.enum(WEB_SESSION_AUTH_STATES).optional(),
	can_send_followup: z.boolean().optional(),
});

function normalizeOptionalString(value: string | undefined): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createWorkerManifestWithBrowserSessionSeed(
	seed: z.infer<typeof browserSessionSeedSchema> | undefined,
): JobWorkerManifest {
	const manifest = createEmptyWorkerManifest();
	if (!seed) {
		return manifest;
	}
	const sessionUrl = normalizeOptionalString(seed.session_url);
	if (!sessionUrl) {
		return manifest;
	}
	const authState: WebSessionAuthState = seed.auth_state ?? 'unknown';
	const canSendFollowup = typeof seed.can_send_followup === 'boolean' ? seed.can_send_followup : null;
	const approvalState: WebSessionApprovalState = authState === 'approval_required' ? 'pending' : 'none';
	const followupState: WebSessionFollowupState =
		canSendFollowup === true ? 'ready' : canSendFollowup === false ? 'not_available' : 'unknown';
	return {
		...manifest,
		browser: {
			...(manifest.browser ?? {}),
			target: sessionUrl,
			session_context: {
				provider: 'chatgpt_web',
				session_url: sessionUrl,
				canonical_conversation_url: normalizeOptionalString(seed.canonical_conversation_url),
				conversation_id: normalizeOptionalString(seed.conversation_id),
				page_url_at_attach: null,
				page_title_at_attach: null,
				auth_state: authState,
				approval_state: approvalState,
				followup_state: followupState,
				can_send_followup: canSendFollowup,
				last_user_visible_action: null,
				last_prompt_digest: null,
				last_followup_at: null,
				linked_job_url: null,
				updated_at: nowIso(),
			},
		},
	};
}
