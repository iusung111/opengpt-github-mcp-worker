import { createMcpHandler } from 'agents/mcp';
import { githubAuthConfigured, githubGet } from './github';
import { buildMcpServer } from './mcp-tools';
import { AppEnv, JobRecord, JobStatus, NextActor } from './types';
import {
	getChatgptMcpAllowedEmails,
	getChatgptMcpAudiences,
	getChatgptMcpAuthMode,
	getAllowedRepos,
	getAllowedWorkflows,
	getAllowedWorkflowsByRepo,
	getEnvAllowedWorkflowsByRepo,
	getFileAllowedWorkflowsByRepo,
	getAuditRetentionCount,
	getBranchPrefix,
	getDeliveryRetentionCount,
	getDispatchDedupeWindowMs,
	getMcpAccessMode,
	getMcpAllowedEmailDomains,
	getMcpAllowedEmails,
	getMcpRequireAccessAuth,
	getReviewStaleAfterMs,
	getWorkingStaleAfterMs,
	queueFetch,
	queueJson,
	fail,
	ok,
	repoAllowed,
	jsonResponse,
	diagnosticLog,
} from './utils';
import { authorizeChatgptMcpRequest, authorizeDirectMcpRequest, queueRequestAuthorized } from './auth';
import { verifyWebhookSignature } from './queue-helpers';

export async function handleWebhook(request: Request, env: AppEnv): Promise<Response> {
	if (env.REQUIRE_WEBHOOK_SECRET === 'true' && !env.WEBHOOK_SECRET) {
		return jsonResponse(fail('server_error', 'webhook secret configuration missing'), 500);
	}
	const signature = request.headers.get('x-hub-signature-256');
	const deliveryId = request.headers.get('x-github-delivery') ?? undefined;
	const bodyText = await request.text();
	if (env.REQUIRE_WEBHOOK_SECRET === 'true') {
		const verified = await verifyWebhookSignature(env.WEBHOOK_SECRET ?? '', bodyText, signature);
		if (!verified) {
			return jsonResponse(fail('unauthorized', 'invalid webhook signature'), 401);
		}
	}
	let payload: any;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return jsonResponse(fail('bad_request', 'invalid json'), 400);
	}
	const repo = payload.repository?.full_name;
	if (!repo || !repoAllowed(env, repo)) {
		return jsonResponse(fail('repo_not_allowlisted', 'repository not allowlisted'), 403);
	}
	try {
		const result = await queueJson(env, { action: 'github_event', payload, delivery_id: deliveryId });
		if (result.ok && result.data) {
			return jsonResponse({ ok: true, ...result.data });
		}
		return jsonResponse(result);
	} catch (error) {
		return jsonResponse(fail('webhook_processing_failed', error), 500);
	}
}

export async function handleQueueApi(request: Request, env: AppEnv): Promise<Response> {
	if (!queueRequestAuthorized(request, env)) {
		return jsonResponse(fail('unauthorized', 'invalid queue token'), 401);
	}
	const url = new URL(request.url);
	if (request.method === 'POST' && url.pathname === '/queue/job') {
		const job = (await request.json()) as Partial<JobRecord> & { job_id: string };
		return queueFetch(env, { action: 'job_upsert', job });
	}
	if (request.method === 'GET' && url.pathname.startsWith('/queue/job/')) {
		const jobId = url.pathname.split('/').pop();
		return queueFetch(env, { action: 'job_get', job_id: jobId });
	}
	if (request.method === 'GET' && url.pathname === '/queue/jobs') {
		const status = url.searchParams.get('status') as JobStatus | null;
		const nextActor = url.searchParams.get('next_actor') as NextActor | null;
		return queueFetch(env, {
			action: 'jobs_list',
			status: status ?? undefined,
			next_actor: nextActor ?? undefined,
		});
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}

export function handleHealth(env: AppEnv): Response {
	return jsonResponse({
		ok: true,
		service: 'opengpt-github-mcp-worker',
		runtime: 'cloudflare-workers',
		durable_object_binding: true,
		auth_configured: githubAuthConfigured(env),
		allowed_repos: getAllowedRepos(env),
		allowed_workflows: getAllowedWorkflows(env),
		allowed_workflows_file_by_repo: getFileAllowedWorkflowsByRepo(),
		allowed_workflows_env_by_repo: getEnvAllowedWorkflowsByRepo(env),
		allowed_workflows_by_repo: getAllowedWorkflowsByRepo(env),
		branch_prefix: getBranchPrefix(env),
		require_webhook_secret: String(env.REQUIRE_WEBHOOK_SECRET) === 'true',
		working_stale_after_ms: getWorkingStaleAfterMs(env),
		review_stale_after_ms: getReviewStaleAfterMs(env),
		dispatch_dedupe_window_ms: getDispatchDedupeWindowMs(env),
		audit_retention_count: getAuditRetentionCount(env),
		delivery_retention_count: getDeliveryRetentionCount(env),
		mcp_access_auth_required: getMcpRequireAccessAuth(env),
		mcp_access_mode: getMcpAccessMode(env),
		mcp_allowed_emails_count: getMcpAllowedEmails(env).length,
		mcp_allowed_email_domains_count: getMcpAllowedEmailDomains(env).length,
		direct_mcp_auth_required: getMcpRequireAccessAuth(env),
		direct_mcp_auth_mode: getMcpAccessMode(env),
		chatgpt_mcp_auth_mode: getChatgptMcpAuthMode(env),
		chatgpt_allowed_emails_count: getChatgptMcpAllowedEmails(env).length,
	});
}

export function handleOAuthProtectedResourceMetadata(request: Request, env: AppEnv): Response {
	const url = new URL(request.url);
	const origin = `${url.protocol}//${url.host}`;
	const issuer = env.CHATGPT_MCP_ISSUER?.trim() || null;
	const audiences = getChatgptMcpAudiences(env);
	return jsonResponse({
		resource: `${origin}/chatgpt/mcp`,
		authorization_servers: issuer ? [issuer.replace(/\/$/, '')] : [],
		scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
		bearer_methods_supported: ['header'],
		resource_documentation: `${origin}/docs/CHATGPT_MCP.md`,
		audiences,
	});
}

export async function handleGitHubAppInstallation(env: AppEnv): Promise<Response> {
	if (!githubAuthConfigured(env)) {
		return jsonResponse(fail('github_auth_not_configured', 'github auth not configured'), 400);
	}
	try {
		const repo = getAllowedRepos(env)[0] ?? 'iusung111/OpenGPT';
		const [owner, name] = repo.split('/');
		const data = await githubGet(env, `/repos/${owner}/${name}`);
		return jsonResponse(ok({ repository: data as Record<string, unknown> }));
	} catch (error) {
		return jsonResponse(fail('github_app_installation_failed', error), 502);
	}
}

export function getMcpHandler(env: AppEnv): ReturnType<typeof createMcpHandler> {
	return createMcpHandler(buildMcpServer(env) as never, {
		route: '/mcp',
		enableJsonResponse: true,
	});
}

export function getChatgptMcpHandler(env: AppEnv): ReturnType<typeof createMcpHandler> {
	return createMcpHandler(buildMcpServer(env) as never, {
		route: '/chatgpt/mcp',
		enableJsonResponse: true,
	});
}

export function chatgptMcpBootstrapResponse(request: Request, env: AppEnv): Response {
	const headers = new Headers({
		'access-control-allow-origin': '*',
		'access-control-allow-headers': 'Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version',
		'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
		'access-control-max-age': '86400',
	});
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers });
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers });
	}
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(
		JSON.stringify({
			ok: true,
			service: 'opengpt-github-mcp-worker',
			route: '/chatgpt/mcp',
			auth_type: 'oauth',
			oauth: {
				issuer: env.CHATGPT_MCP_ISSUER ?? null,
				authorization_url: env.CHATGPT_MCP_ISSUER ? new URL('/authorize', env.CHATGPT_MCP_ISSUER).toString() : null,
				token_url: env.CHATGPT_MCP_ISSUER ? new URL('/oauth/token', env.CHATGPT_MCP_ISSUER).toString() : null,
			},
		}),
		{ status: 200, headers },
	);
}

function ensureChatgptMcpAcceptHeader(request: Request): Request {
	const accept = request.headers.get('accept') ?? '';
	const hasJson = accept.includes('application/json');
	const hasEventStream = accept.includes('text/event-stream');
	if (hasJson && hasEventStream) {
		return request;
	}
	const headers = new Headers(request.headers);
	headers.set('accept', 'application/json, text/event-stream');
	return new Request(request, { headers });
}

async function getChatgptRpcMethod(request: Request): Promise<string | null> {
	if (request.method !== 'POST') {
		return null;
	}
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) {
		return null;
	}
	try {
		const payload = (await request.clone().json()) as { method?: string };
		return typeof payload.method === 'string' ? payload.method : null;
	} catch {
		return null;
	}
}

export async function handleMcpRequest(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const auth = await authorizeDirectMcpRequest(request, env);
	if (!auth.ok) {
		return jsonResponse(fail(auth.code ?? 'unauthorized', auth.error ?? 'unauthorized'), auth.status ?? 401);
	}
	const handler = getMcpHandler(env);
	return handler(request, env, ctx);
}

export async function handleChatgptMcpRequest(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const hasBearerToken = Boolean(request.headers.get('authorization')?.trim().startsWith('Bearer '));
	const accept = request.headers.get('accept') ?? '';
	const rpcMethod = await getChatgptRpcMethod(request);

	// ChatGPT validates the MCP URL before it can complete OAuth setup.
	// Serve a simple bootstrap response for unauthenticated probes instead of
	// forcing SSE negotiation or bearer auth at URL-entry time.
	if ((request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') && !hasBearerToken) {
		diagnosticLog('chatgpt_mcp_bootstrap', {
			method: request.method,
			accept,
			has_bearer_token: false,
		});
		return chatgptMcpBootstrapResponse(request, env);
	}

	// ChatGPT completes MCP session bootstrap before tool execution.
	// Only actual tool invocation requires bearer auth; initialize/list phases
	// should stay reachable after OAuth succeeds so ChatGPT can complete setup.
	if (!hasBearerToken && rpcMethod !== 'tools/call') {
		diagnosticLog('chatgpt_mcp_public_rpc', {
			method: request.method,
			accept,
			rpc_method: rpcMethod,
			has_bearer_token: false,
		});
		const handler = getChatgptMcpHandler(env);
		return handler(ensureChatgptMcpAcceptHeader(request), env, ctx);
	}

	const auth = await authorizeChatgptMcpRequest(request, env);
	if (!auth.ok) {
		diagnosticLog('chatgpt_mcp_auth_failed', {
			method: request.method,
			accept,
			rpc_method: rpcMethod,
			has_bearer_token: hasBearerToken,
			status: auth.status ?? 401,
			code: auth.code ?? 'unauthorized',
			error: auth.error ?? 'unauthorized',
		});
		const response = jsonResponse(fail(auth.code ?? 'unauthorized', auth.error ?? 'unauthorized'), auth.status ?? 401);
		if ((auth.status ?? 401) === 401) {
			const url = new URL(request.url);
			const resourceMetadataUrl = `${url.protocol}//${url.host}/.well-known/oauth-protected-resource/chatgpt/mcp`;
			response.headers.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
		}
		return response;
	}
	diagnosticLog('chatgpt_mcp_auth_ok', {
		method: request.method,
		accept,
		rpc_method: rpcMethod,
		has_bearer_token: hasBearerToken,
		email: auth.email ?? null,
	});
	const handler = getChatgptMcpHandler(env);
	return handler(ensureChatgptMcpAcceptHeader(request), env, ctx);
}
