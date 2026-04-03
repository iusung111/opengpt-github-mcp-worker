import type { AppEnv } from '../contracts';
import { handleGuiApi } from '../gui-api';
import { fail, jsonResponse } from '../utils';
import { handleHealth } from './http/health';
import { handleOAuthProtectedResourceMetadata, handleGitHubAppInstallation } from './http/oauth';
import { handleQueueApi } from './http/queue-api';
import { handleWebhook } from './http/webhook';
import { chatgptMcpBootstrapResponse, handleChatgptMcpRequest, handleMcpRequest } from './mcp/handlers';

function isReadMethod(request: Request): boolean {
	return request.method === 'GET' || request.method === 'HEAD';
}

export async function routeRequest(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	if (isReadMethod(request) && url.pathname === '/') {
		return Response.redirect(`${url.protocol}//${url.host}/gui/`, 307);
	}
	if (isReadMethod(request) && url.pathname === '/healthz') {
		return handleHealth(env);
	}
	if (url.pathname.startsWith('/gui/api/')) {
		return handleGuiApi(request, env);
	}
	if (isReadMethod(request) && url.pathname === '/github/app-installation') {
		return handleGitHubAppInstallation(env);
	}
	if (
		isReadMethod(request) &&
		(url.pathname === '/.well-known/oauth-protected-resource' ||
			url.pathname === '/.well-known/oauth-protected-resource/chatgpt/mcp')
	) {
		return handleOAuthProtectedResourceMetadata(request, env);
	}
	if (url.pathname === '/webhooks/github') {
		return handleWebhook(request, env);
	}
	if (url.pathname.startsWith('/queue/')) {
		return handleQueueApi(request, env);
	}
	if (url.pathname === '/mcp') {
		return handleMcpRequest(request, env, ctx);
	}
	if (url.pathname === '/chatgpt/mcp') {
		const hasBearerToken = Boolean(request.headers.get('authorization')?.trim().startsWith('Bearer '));
		if ((request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') && !hasBearerToken) {
			return chatgptMcpBootstrapResponse(request, env);
		}
		return handleChatgptMcpRequest(request, env, ctx);
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}
