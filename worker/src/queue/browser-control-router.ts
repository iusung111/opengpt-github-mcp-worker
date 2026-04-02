import type { BrowserRemoteCommandKind, JobRecord } from '../contracts';
import { BROWSER_REMOTE_COMMAND_KINDS } from '../contracts';
import {
	claimBrowserRemoteCommand,
	completeBrowserRemoteCommand,
	disconnectBrowserRemoteSession,
	enqueueBrowserRemoteCommand,
	normalizeBrowserRemoteControl,
	upsertBrowserRemoteSession,
} from '../browser-remote-control';
import { computeRunAttentionStatus } from './projections';
import { fail, jsonResponse, ok } from '../utils';

function parseBrowserCommandKind(value: unknown): BrowserRemoteCommandKind | null {
	if (typeof value !== 'string') {
		return null;
	}
	return BROWSER_REMOTE_COMMAND_KINDS.includes(value as BrowserRemoteCommandKind) ? (value as BrowserRemoteCommandKind) : null;
}

function recordBody(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export interface BrowserControlRouterContext {
	getBrowserRemoteControlState(): Promise<ReturnType<typeof normalizeBrowserRemoteControl>>;
	persistBrowserRemoteControlState(value: unknown): Promise<ReturnType<typeof normalizeBrowserRemoteControl>>;
	getJob(jobId: string): Promise<JobRecord | null>;
	writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

export async function handleBrowserControlRequest(
	request: Request,
	url: URL,
	context: BrowserControlRouterContext,
): Promise<Response> {
	const parts = url.pathname.split('/').filter(Boolean);
	if (parts.length === 1 && request.method === 'GET') {
		return jsonResponse(ok({ browser_control: await context.getBrowserRemoteControlState() }));
	}
	if (parts.length === 2 && parts[1] === 'session' && request.method === 'POST') {
		const body = recordBody(await request.json().catch(() => null));
		if (!body) return jsonResponse(fail('bad_request', 'invalid json body'), 400);
		const nextState = upsertBrowserRemoteSession(await context.getBrowserRemoteControlState(), {
			session_id: typeof body.session_id === 'string' ? body.session_id : null,
			agent_name: typeof body.agent_name === 'string' ? body.agent_name : null,
			page_url: typeof body.page_url === 'string' ? body.page_url : null,
			page_title: typeof body.page_title === 'string' ? body.page_title : null,
			browser_name: typeof body.browser_name === 'string' ? body.browser_name : null,
			cdp_origin: typeof body.cdp_origin === 'string' ? body.cdp_origin : null,
		});
		return jsonResponse(ok({ browser_control: await context.persistBrowserRemoteControlState(nextState) }));
	}
	if (parts.length === 3 && parts[1] === 'session' && parts[2] === 'disconnect' && request.method === 'POST') {
		return jsonResponse(ok({ browser_control: await context.persistBrowserRemoteControlState(disconnectBrowserRemoteSession(await context.getBrowserRemoteControlState())) }));
	}
	if (parts.length === 2 && parts[1] === 'commands' && request.method === 'POST') {
		const body = recordBody(await request.json().catch(() => null));
		if (!body) return jsonResponse(fail('bad_request', 'invalid json body'), 400);
		const kind = parseBrowserCommandKind(body.kind);
		if (!kind) return jsonResponse(fail('bad_request', `kind must be one of ${BROWSER_REMOTE_COMMAND_KINDS.join(', ')}`), 400);
		const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
		if (!jobId) return jsonResponse(fail('bad_request', 'job_id is required'), 400);
		const job = await context.getJob(jobId);
		if (!job) return jsonResponse(fail('job_not_found', `job ${jobId} not found`), 404);
		let nextState;
		try {
			nextState = enqueueBrowserRemoteCommand(await context.getBrowserRemoteControlState(), {
				kind,
				job_id: jobId,
				job_title: typeof body.job_title === 'string' ? body.job_title : job.job_id,
				repo: typeof body.repo === 'string' ? body.repo : job.repo,
				run_status: computeRunAttentionStatus(job),
				label: typeof body.label === 'string' ? body.label : null,
				prompt: typeof body.prompt === 'string' ? body.prompt : null,
				page_url_hint: typeof body.page_url_hint === 'string' ? body.page_url_hint : null,
				created_by: typeof body.created_by === 'string' ? body.created_by : null,
			});
		} catch (error) {
			return jsonResponse(fail('browser_control_enqueue_failed', error instanceof Error ? error.message : String(error)), 409);
		}
		await context.writeAudit('browser_control_command_enqueued', {
			job_id: job.job_id,
			repo: job.repo,
			command_kind: kind,
			command_label: typeof body.label === 'string' ? body.label : null,
			created_by: typeof body.created_by === 'string' ? body.created_by : null,
			source_layer: 'gpt',
			attention_status: computeRunAttentionStatus(job),
			message: `Browser companion queued ${kind} for the run console.`,
		});
		return jsonResponse(ok({ browser_control: await context.persistBrowserRemoteControlState(nextState) }));
	}
	if (parts.length === 3 && parts[1] === 'commands' && parts[2] === 'next' && request.method === 'GET') {
		const sessionId = url.searchParams.get('session_id')?.trim();
		if (!sessionId) return jsonResponse(fail('bad_request', 'session_id is required'), 400);
		const jobIdFilter = url.searchParams.get('job_id')?.trim() || null;
		const currentState = await context.getBrowserRemoteControlState();
		const currentCommand = currentState?.pending_command ?? null;
		if (jobIdFilter && currentCommand?.job_id && currentCommand.job_id !== jobIdFilter) {
			return jsonResponse(ok({ browser_control: currentState, command: null }));
		}
		const claimed = claimBrowserRemoteCommand(currentState, { session_id: sessionId });
		return jsonResponse(ok({ browser_control: await context.persistBrowserRemoteControlState(claimed.control), command: claimed.command }));
	}
	if (parts.length === 4 && parts[1] === 'commands' && parts[3] === 'complete' && request.method === 'POST') {
		const commandId = decodeURIComponent(parts[2] ?? '').trim();
		if (!commandId) return jsonResponse(fail('bad_request', 'command_id is required'), 400);
		const body = recordBody(await request.json().catch(() => null));
		if (!body) return jsonResponse(fail('bad_request', 'invalid json body'), 400);
		const currentState = await context.getBrowserRemoteControlState();
		const pendingCommand = currentState?.pending_command ?? null;
		let nextState;
		try {
			nextState = completeBrowserRemoteCommand(currentState, {
				command_id: commandId,
				ok: body.ok === true,
				summary: typeof body.summary === 'string' ? body.summary : null,
				error: typeof body.error === 'string' ? body.error : null,
				matched_actions: Array.isArray(body.matched_actions) ? body.matched_actions.map((item) => String(item)) : [],
				page_url: typeof body.page_url === 'string' ? body.page_url : null,
				page_title: typeof body.page_title === 'string' ? body.page_title : null,
			});
		} catch (error) {
			return jsonResponse(fail('browser_control_complete_failed', error instanceof Error ? error.message : String(error)), 409);
		}
		const browserControl = await context.persistBrowserRemoteControlState(nextState);
		if (pendingCommand?.job_id) {
			const job = await context.getJob(pendingCommand.job_id);
			await context.writeAudit('browser_control_command_completed', {
				job_id: pendingCommand.job_id,
				repo: pendingCommand.repo ?? job?.repo ?? null,
				command_kind: pendingCommand.kind,
				command_label: pendingCommand.label ?? null,
				ok: body.ok === true,
				summary: typeof body.summary === 'string' ? body.summary : null,
				error: typeof body.error === 'string' ? body.error : null,
				matched_actions: Array.isArray(body.matched_actions) ? body.matched_actions.map((item) => String(item)) : [],
				page_url: typeof body.page_url === 'string' ? body.page_url : null,
				page_title: typeof body.page_title === 'string' ? body.page_title : null,
				source_layer: 'gpt',
				attention_status: job ? computeRunAttentionStatus(job) : pendingCommand.run_status ?? null,
				message: body.ok === true ? `Browser companion completed ${pendingCommand.kind}.` : typeof body.error === 'string' ? body.error : `Browser companion failed ${pendingCommand.kind}.`,
			});
		}
		return jsonResponse(ok({ browser_control: browserControl }));
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}
