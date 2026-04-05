import type { AppEnv } from '../contracts';
import { handleGuiApi } from '../gui-api';
import { fail, jsonResponse } from '../utils';
import { handleHealth } from './http/health';
import { handleOAuthProtectedResourceMetadata, handleGitHubAppInstallation } from './http/oauth';
import { handleQueueApi } from './http/queue-api';
import { handleWebhook } from './http/webhook';
import {
	canonicalizeRequestPath,
	chatgptMcpBootstrapResponse,
	handleChatgptMcpRequest,
	handleMcpRequest,
	resolveRuntimeRouteInfo,
} from './mcp/handlers';

function isReadMethod(request: Request): boolean {
	return request.method === 'GET' || request.method === 'HEAD';
}

export async function routeRequest(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const runtimeRoutes = resolveRuntimeRouteInfo(request);

	if (isReadMethod(request) && runtimeRoutes.isRoot) {
		return Response.redirect(`${url.protocol}//${url.host}${runtimeRoutes.guiRouteWithSlash}`, 307);
	}
	if (isReadMethod(request) && runtimeRoutes.isGuiRoot && !url.pathname.endsWith('/')) {
		return Response.redirect(`${url.protocol}//${url.host}${runtimeRoutes.guiRouteWithSlash}`, 307);
	}
	if (isReadMethod(request) && url.pathname === '/healthz') {
		return handleHealth(env);
	}
	if (runtimeRoutes.isGuiApi) {
		const strippedGuiApiPath = runtimeRoutes.normalizedPath.replace(/^.*?(\/gui\/api(?:\/.*)?$)/, '$1');
		return handleGuiApi(canonicalizeRequestPath(request, strippedGuiApiPath), env);
	}
	if (isReadMethod(request) && url.pathname === '/github/app-installation') {
		return handleGitHubAppInstallation(env);
	}
	if (isReadMethod(request) && (url.pathname === '/.well-known/oauth-protected-resource' || runtimeRoutes.isChatgptOauthMetadata)) {
		return handleOAuthProtectedResourceMetadata(request, env);
	}
	if (url.pathname === '/webhooks/github') {
		return handleWebhook(request, env);
	}
	if (url.pathname.startsWith('/queue/')) {
		return handleQueueApi(request, env);
	}
	if (runtimeRoutes.isDirectMcp) {
		return handleMcpRequest(request, env, ctx);
	}
	if (runtimeRoutes.isChatgptMcp) {
		const hasBearerToken = Boolean(request.headers.get('authorization')?.trim().startsWith('Bearer '));
		if ((request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') && !hasBearerToken) {
			return chatgptMcpBootstrapResponse(request, env);
		}
		return handleChatgptMcpRequest(request, env, ctx);
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}
