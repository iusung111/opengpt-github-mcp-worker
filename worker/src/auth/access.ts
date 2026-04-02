import type { AppEnv } from '../contracts';
import { getMcpRequireAccessAuth } from '../utils';
import { getAccessAllowlist, getEmailDomain, getMcpAccessEmail, getMcpAccessJwtAssertion } from './shared';
import type { McpAccessAuthResult } from './types';

export function authorizeMcpRequest(request: Request, env: AppEnv): McpAccessAuthResult {
	if (!getMcpRequireAccessAuth(env)) {
		return { ok: true, email: null };
	}
	const email = getMcpAccessEmail(request);
	const jwtAssertion = getMcpAccessJwtAssertion(request);
	if (!email || !jwtAssertion) {
		return { ok: false, status: 401, code: 'unauthorized', error: 'missing Cloudflare Access identity headers' };
	}
	const { emails: allowedEmails, domains: allowedDomains } = getAccessAllowlist(env);
	if (allowedEmails.length === 0 && allowedDomains.length === 0) return { ok: true, email };
	const emailDomain = getEmailDomain(email);
	const emailAllowed = allowedEmails.includes(email);
	const domainAllowed = emailDomain !== null && allowedDomains.includes(emailDomain);
	if (emailAllowed || domainAllowed) return { ok: true, email };
	return { ok: false, status: 403, code: 'forbidden', error: 'Cloudflare Access identity is not allowed for MCP access' };
}
