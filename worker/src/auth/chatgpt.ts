import type { AppEnv } from '../contracts';
import { getChatgptMcpAuthMode } from '../utils';
import { authorizeMcpRequest } from './access';
import { getBearerToken, getChatgptAllowlist, getMcpAccessEmail, getMcpAccessJwtAssertion, verifyBearerIdentity } from './shared';
import type { McpAccessAuthResult } from './types';

export async function authorizeDirectMcpRequest(request: Request, env: AppEnv): Promise<McpAccessAuthResult> {
	const accessHeadersPresent = Boolean(getMcpAccessEmail(request) || getMcpAccessJwtAssertion(request));
	if (accessHeadersPresent) return authorizeMcpRequest(request, env);
	const bearerToken = getBearerToken(request);
	if (!bearerToken) return authorizeMcpRequest(request, env);
	if (getChatgptMcpAuthMode(env) === 'disabled') return authorizeMcpRequest(request, env);
	return authorizeChatgptMcpRequest(request, env);
}

export async function authorizeChatgptMcpRequest(request: Request, env: AppEnv): Promise<McpAccessAuthResult> {
	if (getChatgptMcpAuthMode(env) === 'disabled') {
		return { ok: false, status: 503, code: 'server_error', error: 'ChatGPT MCP OIDC auth is not configured' };
	}
	const token = getBearerToken(request);
	if (!token) return { ok: false, status: 401, code: 'unauthorized', error: 'missing bearer token' };
	let email: string;
	try {
		email = await verifyBearerIdentity(token, env);
	} catch (error) {
		return { ok: false, status: 401, code: 'unauthorized', error: error instanceof Error ? error.message : String(error) };
	}
	const allowedEmails = getChatgptAllowlist(env);
	if (allowedEmails.length === 0) {
		return { ok: false, status: 403, code: 'forbidden', error: 'ChatGPT MCP identity allowlist is empty' };
	}
	if (!allowedEmails.includes(email)) {
		return { ok: false, status: 403, code: 'forbidden', error: 'ChatGPT MCP identity is not allowed' };
	}
	return { ok: true, email };
}

export async function authorizeGuiOperatorRequest(request: Request, env: AppEnv): Promise<McpAccessAuthResult> {
	const accessEmail = getMcpAccessEmail(request);
	const accessHeadersPresent = Boolean(accessEmail || getMcpAccessJwtAssertion(request));
	if (accessHeadersPresent) {
		const result = authorizeMcpRequest(request, env);
		return result.ok ? { ...result, email: result.email ?? accessEmail, auth_type: 'access' } : result;
	}
	const bearerToken = getBearerToken(request);
	if (bearerToken) {
		const result = await authorizeChatgptMcpRequest(request, env);
		return result.ok ? { ...result, auth_type: 'bearer' } : result;
	}
	return {
		ok: false,
		status: 401,
		code: 'unauthorized',
		error: 'GUI operator auth requires Cloudflare Access or a bearer token',
	};
}
