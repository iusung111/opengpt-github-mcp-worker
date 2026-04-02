import { createMcpHandler } from 'agents/mcp';
import type { AppEnv } from '../../contracts';
import { authorizeChatgptMcpRequest, authorizeDirectMcpRequest } from '../../auth';
import { preflightMcpToolCallRequest } from '../../mcp-tool-contracts';
import { buildMcpServer } from '../../mcp-tools';
import { diagnosticLog, fail, jsonResponse } from '../../utils';

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
	const nextRequest = await preflightMcpToolCallRequest(request);
	if (nextRequest instanceof Response) {
		return nextRequest;
	}
	return handler(nextRequest, env, ctx);
}

export async function handleChatgptMcpRequest(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const hasBearerToken = Boolean(request.headers.get('authorization')?.trim().startsWith('Bearer '));
	const accept = request.headers.get('accept') ?? '';
	const rpcMethod = await getChatgptRpcMethod(request);
	if ((request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') && !hasBearerToken) {
		diagnosticLog('chatgpt_mcp_bootstrap', {
			method: request.method,
			accept,
			has_bearer_token: false,
		});
		return chatgptMcpBootstrapResponse(request, env);
	}
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
			response.headers.set('WWW-Authenticate', `Bearer resource_metadata=\"${resourceMetadataUrl}\"`);
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
	const nextRequest = await preflightMcpToolCallRequest(ensureChatgptMcpAcceptHeader(request));
	if (nextRequest instanceof Response) {
		return nextRequest;
	}
	return handler(nextRequest, env, ctx);
}
