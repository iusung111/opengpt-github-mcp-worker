import { createMcpHandler } from 'agents/mcp';
import type { AppEnv } from '../../contracts';
import { authorizeChatgptMcpRequest, authorizeDirectMcpRequest } from '../../auth';
import { preflightMcpToolCallRequest } from '../../mcp-tool-contracts';
import { buildMcpServer } from '../../mcp-tools';
import { incrementReadCounter } from '../../read-observability';
import { buildOidcEndpointUrl, diagnosticLog, fail, jsonResponse } from '../../utils';

const DIRECT_MCP_ROUTE = '/mcp';
const CHATGPT_MCP_ROUTE = '/chatgpt/mcp';
const CHATGPT_OAUTH_METADATA_ROUTE = '/.well-known/oauth-protected-resource/chatgpt/mcp';
const GUI_ROUTE = '/gui';

function normalizePathname(pathname: string): string {
	const collapsed = pathname.replace(/\/{2,}/g, '/');
	if (collapsed === '/') {
		return '/';
	}
	return collapsed.replace(/\/+$/, '') || '/';
}

function matchRoutePrefix(pathname: string, route: string): string | null {
	if (pathname === route) {
		return '';
	}
	if (!pathname.endsWith(route)) {
		return null;
	}
	const prefix = pathname.slice(0, -route.length);
	return prefix.startsWith('/') ? prefix : null;
}

type RuntimeRouteInfo = {
	normalizedPath: string;
	directMcpRoute: string;
	chatgptMcpRoute: string;
	chatgptOauthMetadataRoute: string;
	guiRoute: string;
	guiRouteWithSlash: string;
	isRoot: boolean;
	isDirectMcp: boolean;
	isChatgptMcp: boolean;
	isChatgptOauthMetadata: boolean;
	isGuiRoot: boolean;
	isGuiApi: boolean;
};

export function resolveRuntimeRouteInfo(input: Request | URL | string): RuntimeRouteInfo {
	const pathname =
		typeof input === 'string' ? input : input instanceof Request ? new URL(input.url).pathname : input.pathname;
	const normalizedPath = normalizePathname(pathname);
	const oauthPrefix = matchRoutePrefix(normalizedPath, CHATGPT_OAUTH_METADATA_ROUTE);
	const chatgptPrefix = matchRoutePrefix(normalizedPath, CHATGPT_MCP_ROUTE);
	const directPrefix = chatgptPrefix === null ? matchRoutePrefix(normalizedPath, DIRECT_MCP_ROUTE) : null;
	const guiPrefix = matchRoutePrefix(normalizedPath, GUI_ROUTE);
	const guiApiMatch =
		normalizedPath === '/gui/api' || normalizedPath.startsWith('/gui/api/')
			? ''
			: normalizedPath.match(/^(.*)\/gui\/api(?:\/.*)?$/)?.[1] ?? null;
	const prefix = oauthPrefix ?? chatgptPrefix ?? directPrefix ?? guiPrefix ?? guiApiMatch ?? '';
	const directMcpRoute = `${prefix}${DIRECT_MCP_ROUTE}` || DIRECT_MCP_ROUTE;
	const chatgptMcpRoute = `${prefix}${CHATGPT_MCP_ROUTE}` || CHATGPT_MCP_ROUTE;
	const chatgptOauthMetadataRoute = `${prefix}${CHATGPT_OAUTH_METADATA_ROUTE}` || CHATGPT_OAUTH_METADATA_ROUTE;
	const guiRoute = `${prefix}${GUI_ROUTE}` || GUI_ROUTE;
	return {
		normalizedPath,
		directMcpRoute,
		chatgptMcpRoute,
		chatgptOauthMetadataRoute,
		guiRoute,
		guiRouteWithSlash: `${guiRoute}/`,
		isRoot: normalizedPath === '/',
		isDirectMcp: directPrefix !== null,
		isChatgptMcp: chatgptPrefix !== null,
		isChatgptOauthMetadata: oauthPrefix !== null,
		isGuiRoot: guiPrefix !== null,
		isGuiApi: guiApiMatch !== null,
	};
}

export function canonicalizeRequestPath(request: Request, pathname: string): Request {
	const url = new URL(request.url);
	const nextPathname = normalizePathname(pathname);
	if (url.pathname === nextPathname) {
		return request;
	}
	url.pathname = nextPathname;
	return new Request(url.toString(), request);
}

export function getMcpHandler(env: AppEnv, route = DIRECT_MCP_ROUTE): ReturnType<typeof createMcpHandler> {
	return createMcpHandler(buildMcpServer(env, { enableWidgets: true, profile: 'direct_full' }) as never, {
		route,
		enableJsonResponse: true,
	});
}

export function getChatgptMcpHandler(env: AppEnv, route = CHATGPT_MCP_ROUTE): ReturnType<typeof createMcpHandler> {
	return createMcpHandler(buildMcpServer(env, {
		enableWidgets: false,
		stripWidgets: true,
		profile: 'direct_full',
	}) as never, {
		route,
		enableJsonResponse: true,
	});
}

export function getChatgptPublicMcpHandler(env: AppEnv, route = CHATGPT_MCP_ROUTE): ReturnType<typeof createMcpHandler> {
	return createMcpHandler(buildMcpServer(env, {
		enableWidgets: true,
		stripWidgets: false,
		profile: 'chatgpt_public',
	}) as never, {
		route,
		enableJsonResponse: true,
	});
}

export function chatgptMcpBootstrapResponse(request: Request, env: AppEnv): Response {
	const runtimeRoutes = resolveRuntimeRouteInfo(request);
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
			route: runtimeRoutes.chatgptMcpRoute,
			auth_type: 'oauth',
			oauth: {
				issuer: env.CHATGPT_MCP_ISSUER ?? null,
				authorization_url: buildOidcEndpointUrl(env.CHATGPT_MCP_ISSUER ?? null, 'authorize'),
				token_url: buildOidcEndpointUrl(env.CHATGPT_MCP_ISSUER ?? null, 'oauth/token'),
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
	const runtimeRoutes = resolveRuntimeRouteInfo(request);
	const nextRequest = canonicalizeRequestPath(request, runtimeRoutes.directMcpRoute);
	const auth = await authorizeDirectMcpRequest(nextRequest, env);
	if (!auth.ok) {
		return jsonResponse(fail(auth.code ?? 'unauthorized', auth.error ?? 'unauthorized'), auth.status ?? 401);
	}
	const handler = getMcpHandler(env, runtimeRoutes.directMcpRoute);
	const preflightRequest = await preflightMcpToolCallRequest(nextRequest, {
		routePolicy: 'direct_full',
	});
	if (preflightRequest instanceof Response) {
		return preflightRequest;
	}
	return handler(preflightRequest, env, ctx);
}

export async function handleChatgptMcpRequest(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const runtimeRoutes = resolveRuntimeRouteInfo(request);
	const nextRequest = canonicalizeRequestPath(request, runtimeRoutes.chatgptMcpRoute);
	const hasBearerToken = Boolean(nextRequest.headers.get('authorization')?.trim().startsWith('Bearer '));
	const accept = nextRequest.headers.get('accept') ?? '';
	const rpcMethod = await getChatgptRpcMethod(nextRequest);
	if ((nextRequest.method === 'GET' || nextRequest.method === 'HEAD' || nextRequest.method === 'OPTIONS') && !hasBearerToken) {
		diagnosticLog('chatgpt_mcp_bootstrap', {
			method: nextRequest.method,
			accept,
			has_bearer_token: false,
			profile: 'chatgpt_public',
		});
		return chatgptMcpBootstrapResponse(nextRequest, env);
	}
	if (!hasBearerToken && rpcMethod !== 'tools/call') {
		incrementReadCounter('mcp_public_rpc_count');
		diagnosticLog('chatgpt_mcp_public_rpc', {
			method: nextRequest.method,
			accept,
			rpc_method: rpcMethod,
			has_bearer_token: false,
		});
		const handler = getChatgptPublicMcpHandler(env, runtimeRoutes.chatgptMcpRoute);
		return handler(ensureChatgptMcpAcceptHeader(nextRequest), env, ctx);
	}

	const auth = await authorizeChatgptMcpRequest(nextRequest, env);
	if (!auth.ok) {
		incrementReadCounter('mcp_auth_fail_count');
		diagnosticLog('chatgpt_mcp_auth_failed', {
			method: nextRequest.method,
			accept,
			rpc_method: rpcMethod,
			has_bearer_token: hasBearerToken,
			status: auth.status ?? 401,
			code: auth.code ?? 'unauthorized',
			error: auth.error ?? 'unauthorized',
		});
		const response = jsonResponse(fail(auth.code ?? 'unauthorized', auth.error ?? 'unauthorized'), auth.status ?? 401);
		if ((auth.status ?? 401) === 401) {
			const url = new URL(nextRequest.url);
			const resourceMetadataUrl = `${url.protocol}//${url.host}${runtimeRoutes.chatgptOauthMetadataRoute}`;
			response.headers.set('WWW-Authenticate', `Bearer resource_metadata=\"${resourceMetadataUrl}\"`);
		}
		return response;
	}
	incrementReadCounter('mcp_auth_ok_count');
	diagnosticLog('chatgpt_mcp_auth_ok', {
		method: nextRequest.method,
		accept,
		rpc_method: rpcMethod,
		has_bearer_token: hasBearerToken,
		email: auth.email ?? null,
		profile: 'direct_full',
	});
	const handler = getChatgptMcpHandler(env, runtimeRoutes.chatgptMcpRoute);
	const preflightRequest = await preflightMcpToolCallRequest(
		ensureChatgptMcpAcceptHeader(nextRequest),
		{ routePolicy: 'direct_full' },
	);
	if (preflightRequest instanceof Response) {
		return preflightRequest;
	}
	return handler(preflightRequest, env, ctx);
}
