import { authorizeGuiOperatorRequest, queueRequestAuthorized } from './auth';
import {
	AppEnv,
	BROWSER_REMOTE_COMMAND_KINDS,
	BrowserRemoteCommandKind,
	JobStatus,
	NextActor,
	QueueEnvelope,
} from './contracts';
import {
	fail,
	getChatgptMcpAuthMode,
	getChatgptMcpIssuer,
	getGuiOidcAudience,
	getGuiOidcClientId,
	getGuiOidcScope,
	jsonResponse,
	ok,
	queueFetch,
} from './utils';

function badRequest(message: string): Response { return jsonResponse(fail('bad_request', message), 400); }
function readJsonBody(request: Request): Promise<Record<string, unknown>> { return request.json() as Promise<Record<string, unknown>>; }

function parseJobStatus(value: string | null): JobStatus | undefined {
	if (
		value === 'queued' ||
		value === 'working' ||
		value === 'review_pending' ||
		value === 'rework_pending' ||
		value === 'done' ||
		value === 'failed'
	) {
		return value;
	}
	return undefined;
}

function parseNextActor(value: string | null): NextActor | undefined {
	if (value === 'worker' || value === 'reviewer' || value === 'system') {
		return value;
	}
	return undefined;
}

function parseAttentionStatus(value: string | null): QueueEnvelope['attention_status'] {
	if (
		value === 'idle' ||
		value === 'pending_approval' ||
		value === 'running' ||
		value === 'paused' ||
		value === 'cancelled' ||
		value === 'interrupted' ||
		value === 'completed' ||
		value === 'failed'
	) {
		return value;
	}
	return undefined;
}

function parseSourceLayer(value: string | null): QueueEnvelope['source_layer'] {
	if (value === 'gpt' || value === 'mcp' || value === 'cloudflare' || value === 'repo' || value === 'system') {
		return value;
	}
	return undefined;
}

function parseControlAction(value: unknown): QueueEnvelope['control_action'] {
	if (value === 'pause' || value === 'resume' || value === 'cancel' || value === 'retry') {
		return value;
	}
	return undefined;
}

function parsePermissionResolution(value: unknown): QueueEnvelope['resolution'] {
	if (value === 'approved' || value === 'rejected' || value === 'superseded') {
		return value;
	}
	return undefined;
}

function parseExpectedState(value: unknown): QueueEnvelope['expected_state'] {
	if (
		value === 'active' ||
		value === 'paused' ||
		value === 'cancelled' ||
		value === 'idle' ||
		value === 'pending_approval' ||
		value === 'running' ||
		value === 'interrupted' ||
		value === 'completed' ||
		value === 'failed'
	) {
		return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBrowserCommandKind(value: unknown): BrowserRemoteCommandKind | null {
	if (typeof value !== 'string') {
		return null;
	}
	return BROWSER_REMOTE_COMMAND_KINDS.includes(value as BrowserRemoteCommandKind)
		? (value as BrowserRemoteCommandKind)
		: null;
}

async function proxyQueueAction(env: AppEnv, payload: QueueEnvelope): Promise<Response> {
	return queueFetch(env, payload);
}

async function proxyBrowserControlAction(
	env: AppEnv,
	path: string,
	options: { method?: string; body?: Record<string, unknown> | null } = {},
): Promise<Response> {
	const id = env.JOB_QUEUE.idFromName('global-job-queue');
	const stub = env.JOB_QUEUE.get(id);
	return stub.fetch(`https://queue.internal${path}`, {
		method: options.method ?? 'GET',
		headers: options.body ? { 'content-type': 'application/json' } : undefined,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
}

export async function handleGuiApi(request: Request, env: AppEnv): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split('/').filter(Boolean);
	if (parts.length < 3 || parts[0] !== 'gui' || parts[1] !== 'api') {
		return jsonResponse(fail('not_found', 'not found'), 404);
	}

	if (request.method === 'GET' && parts.length === 4 && parts[2] === 'auth' && parts[3] === 'config') {
		const issuer = getChatgptMcpIssuer(env);
		const clientId = getGuiOidcClientId(env);
		const audience = getGuiOidcAudience(env);
		const redirectUri = new URL('/gui/', `${url.protocol}//${url.host}`).toString();
		const missing: string[] = [];
		if (getChatgptMcpAuthMode(env) === 'disabled') {
			missing.push('CHATGPT_MCP_AUTH_MODE=oidc');
		}
		if (!issuer) {
			missing.push('CHATGPT_MCP_ISSUER');
		}
		if (!clientId) {
			missing.push('GUI_OIDC_CLIENT_ID');
		}
		if (!audience) {
			missing.push('GUI_OIDC_AUDIENCE or CHATGPT_MCP_AUDIENCE');
		}
		return jsonResponse(
			ok({
				auth: {
					enabled: missing.length === 0,
					provider: 'auth0',
					issuer,
					client_id: clientId,
					audience,
					scope: getGuiOidcScope(env),
					redirect_uri: redirectUri,
					authorization_url: issuer ? new URL('/authorize', issuer).toString() : null,
					token_url: issuer ? new URL('/oauth/token', issuer).toString() : null,
					logout_url: issuer ? new URL('/v2/logout', issuer).toString() : null,
					missing,
				},
			}),
		);
	}

	const isGlobalBrowserControlRoute = parts.length >= 3 && parts[2] === 'browser-control';
	const isJobBrowserControlRoute = parts.length >= 5 && parts[2] === 'jobs' && parts[4] === 'browser-control';
	const browserControlQueueAuth = (isGlobalBrowserControlRoute || isJobBrowserControlRoute) && queueRequestAuthorized(request, env);
	const auth = browserControlQueueAuth ? { ok: true, email: null, auth_type: 'bearer' as const } : await authorizeGuiOperatorRequest(request, env);
	if (!auth.ok) {
		return jsonResponse(
			fail(auth.code ?? 'unauthorized', auth.error ?? 'GUI operator authorization failed'),
			auth.status ?? 401,
		);
	}

	if (request.method === 'GET' && parts.length === 3 && parts[2] === 'session') {
		return jsonResponse(
			ok({
				session: {
					email: auth.email ?? null,
					auth_type: auth.auth_type ?? 'none',
					connected_at: new Date().toISOString(),
				},
				capabilities: {
					live_queue_api: true,
					host_message_bridge: false,
					host_model_context_bridge: false,
					open_external_link: true,
				},
			}),
		);
	}

	if (isGlobalBrowserControlRoute || isJobBrowserControlRoute) {
		const routeJobId = isJobBrowserControlRoute ? decodeURIComponent(parts[3] ?? '').trim() : '';
		if (isJobBrowserControlRoute && !routeJobId) {
			return badRequest('job_id is required');
		}

		if (request.method === 'GET' && ((isGlobalBrowserControlRoute && parts.length === 3) || (isJobBrowserControlRoute && parts.length === 5))) {
			return proxyBrowserControlAction(env, '/browser-control');
		}

		if (request.method === 'POST' && ((isGlobalBrowserControlRoute && parts.length === 4 && parts[3] === 'session') || (isJobBrowserControlRoute && parts.length === 6 && parts[5] === 'session'))) {
			const body = await readJsonBody(request).catch(() => null);
			if (!body) {
				return badRequest('invalid json body');
			}
			return proxyBrowserControlAction(env, '/browser-control/session', {
				method: 'POST',
				body: {
					session_id: typeof body.session_id === 'string' ? body.session_id : null,
					agent_name: typeof body.agent_name === 'string' ? body.agent_name : auth.email,
					page_url: typeof body.page_url === 'string' ? body.page_url : null,
					page_title: typeof body.page_title === 'string' ? body.page_title : null,
					browser_name: typeof body.browser_name === 'string' ? body.browser_name : null,
					cdp_origin: typeof body.cdp_origin === 'string' ? body.cdp_origin : null,
				},
			});
		}

		if (
			request.method === 'POST' &&
			((isGlobalBrowserControlRoute && parts.length === 5 && parts[3] === 'session' && parts[4] === 'disconnect') ||
				(isJobBrowserControlRoute && parts.length === 7 && parts[5] === 'session' && parts[6] === 'disconnect'))
		) {
			return proxyBrowserControlAction(env, '/browser-control/session/disconnect', {
				method: 'POST',
			});
		}

		if (request.method === 'POST' && ((isGlobalBrowserControlRoute && parts.length === 4 && parts[3] === 'commands') || (isJobBrowserControlRoute && parts.length === 6 && parts[5] === 'commands'))) {
			const body = await readJsonBody(request).catch(() => null);
			if (!body) {
				return badRequest('invalid json body');
			}
			const kind = parseBrowserCommandKind(body.kind);
			if (!kind) {
				return badRequest(`kind must be one of ${BROWSER_REMOTE_COMMAND_KINDS.join(', ')}`);
			}
			const jobId = isJobBrowserControlRoute ? routeJobId : typeof body.job_id === 'string' ? body.job_id.trim() : '';
			if (!jobId) {
				return badRequest('job_id is required');
			}
			return proxyBrowserControlAction(env, '/browser-control/commands', {
				method: 'POST',
				body: {
					job_id: jobId,
					job_title: typeof body.job_title === 'string' ? body.job_title : null,
					repo: typeof body.repo === 'string' ? body.repo : null,
					kind,
					label: typeof body.label === 'string' ? body.label : null,
					prompt: typeof body.prompt === 'string' ? body.prompt : null,
					page_url_hint: typeof body.page_url_hint === 'string' ? body.page_url_hint : null,
					created_by: auth.email,
				},
			});
		}

		if (
			request.method === 'GET' &&
			((isGlobalBrowserControlRoute && parts.length === 5 && parts[3] === 'commands' && parts[4] === 'next') ||
				(isJobBrowserControlRoute && parts.length === 7 && parts[5] === 'commands' && parts[6] === 'next'))
		) {
			const sessionId = url.searchParams.get('session_id')?.trim();
			if (!sessionId) {
				return badRequest('session_id is required');
			}
			const nextPath = new URL('/browser-control/commands/next', 'https://queue.internal');
			nextPath.searchParams.set('session_id', sessionId);
			if (routeJobId) {
				nextPath.searchParams.set('job_id', routeJobId);
			}
			return proxyBrowserControlAction(env, `${nextPath.pathname}${nextPath.search}`);
		}

		if (
			request.method === 'POST' &&
			((isGlobalBrowserControlRoute && parts.length === 6 && parts[3] === 'commands' && parts[5] === 'complete') ||
				(isJobBrowserControlRoute && parts.length === 8 && parts[5] === 'commands' && parts[7] === 'complete'))
		) {
			const commandId = decodeURIComponent(isGlobalBrowserControlRoute ? parts[4] ?? '' : parts[6] ?? '').trim();
			if (!commandId) {
				return badRequest('command_id is required');
			}
			const body = await readJsonBody(request).catch(() => null);
			if (!body) {
				return badRequest('invalid json body');
			}
			return proxyBrowserControlAction(env, `/browser-control/commands/${encodeURIComponent(commandId)}/complete`, {
				method: 'POST',
				body: {
					ok: body.ok === true,
					summary: typeof body.summary === 'string' ? body.summary : null,
					error: typeof body.error === 'string' ? body.error : null,
					matched_actions: Array.isArray(body.matched_actions) ? body.matched_actions.map((item) => String(item)) : [],
					page_url: typeof body.page_url === 'string' ? body.page_url : null,
					page_title: typeof body.page_title === 'string' ? body.page_title : null,
				},
			});
		}
		return jsonResponse(fail('not_found', 'not found'), 404);
	}

	if (request.method === 'GET' && parts.length === 3 && parts[2] === 'jobs') {
		return proxyQueueAction(env, {
			action: 'jobs_list',
			status: parseJobStatus(url.searchParams.get('status')),
			next_actor: parseNextActor(url.searchParams.get('next_actor')),
		});
	}

	if (parts.length >= 4 && parts[2] === 'jobs') {
		const jobId = decodeURIComponent(parts[3] ?? '').trim();
		if (!jobId) {
			return badRequest('job_id is required');
		}

		if (request.method === 'GET' && parts.length === 4) {
			return proxyQueueAction(env, {
				action: 'job_progress',
				job_id: jobId,
			});
		}

		if (request.method === 'GET' && parts.length === 5 && parts[4] === 'feed') {
			const rawLimit = Number(url.searchParams.get('limit') ?? 50);
			const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50;
			return proxyQueueAction(env, {
				action: 'job_event_feed',
				job_id: jobId,
				attention_status: parseAttentionStatus(url.searchParams.get('status')),
				source_layer: parseSourceLayer(url.searchParams.get('source_layer')),
				since: url.searchParams.get('since') ?? undefined,
				limit,
			});
		}

		if (request.method === 'POST' && parts.length === 5 && parts[4] === 'control') {
			const body = await readJsonBody(request).catch(() => null);
			if (!body) {
				return badRequest('invalid json body');
			}
			const action = parseControlAction(body.action);
			if (!action) {
				return badRequest('action must be one of pause, resume, cancel, retry');
			}
			return proxyQueueAction(env, {
				action: 'job_control',
				job_id: jobId,
				control_action: action,
				reason: typeof body.reason === 'string' ? body.reason : undefined,
				expected_state: parseExpectedState(body.expected_state),
				resume_strategy:
					body.resume_strategy === 'refresh' || body.resume_strategy === 'redispatch'
						? body.resume_strategy
						: undefined,
			});
		}

		if (request.method === 'POST' && parts.length === 6 && parts[4] === 'approval' && parts[5] === 'resolve') {
			const body = await readJsonBody(request).catch(() => null);
			if (!body) {
				return badRequest('invalid json body');
			}
			const resolution = parsePermissionResolution(body.resolution);
			if (!resolution) {
				return badRequest('resolution must be one of approved, rejected, superseded');
			}
			if (typeof body.request_id !== 'string' || body.request_id.trim().length === 0) {
				return badRequest('request_id is required');
			}
			return proxyQueueAction(env, {
				action: 'permission_request_resolve',
				job_id: jobId,
				request_id: body.request_id.trim(),
				resolution,
				note: typeof body.note === 'string' ? body.note : undefined,
			});
		}
	}

	return jsonResponse(fail('not_found', 'not found'), 404);
}

