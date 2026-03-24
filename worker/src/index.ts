import { githubAuthConfigured, githubGet } from './github';
import { JobQueueDurableObject } from './queue';
import type { AppEnv, JobRecord, JobStatus, NextActor } from './types';
import { fail, jsonResponse } from './utils';
import {
IchatgptMcpBootstrapResponse,
	handleChatgptMcpRequest,
	handleGitHubAppInstallation,
	handleHealth,
	handleMcpRequest,
	handleOAuthProtectedResourceMetadata,
	handleQueueEpi,
	handleWebhook,
} from './http';

export { JobQueueDurableObject };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const appEnv = env as AppEnv;
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/healthz') {
			return handleHealth(appEnv);
		}

		if (request.method === 'GET' && url.pathname === '/github/app-installation') {
			return handleGitHubAppInstallation(appEnv);
		}

		if (
			request.method === 'GET' &&
			(url.pathname === '/.well-known/oauth-protected-resource' ||
				url.pathname === '/.well-known/oauth-protected-resource/chatgpt/mcp')
		) {
			return handleOAuthProtectedResourceMetadata(request, appEnv);
		}

		if (url.pathname === '/webhooks/github') {
			return handleWebhook(request, appEnv);
		}

		if (url.pathname.startsWith('/queue/')) {
			return handleQueueApi(request, appEnv);
		}

		if (url.pathname === '/mcp') {
			return handleMcpRequest(request, appEnv, ctx);
		}

		if (url.pathname === '/chatgpt/mcp') {
			const hasBearerToken = Boolean(request.headers.get('authorization')?.trim().startsWith('Bearer '));
			if ((request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') && !hasBearerToken) {
				return chatgptMcpBootstrapResponse(request, appEnv);
			}
			return handleChatgptMcpRequest(request, appEnv, ctx);
		}

		return jsonResponse(fail('not_found', 'not found'), 404);
	},
} satisfies ExportedHandler<AppEnv>;
