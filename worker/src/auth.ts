import { AppEnv } from './types';
import { getMcpAllowedEmailDomains, getMcpAllowedEmails, getMcpRequireAccessAuth } from './utils';

interface McpAccessAuthResult {
	ok: boolean;
	status?: number;
	code?: string;
	error?: string;
	email?: string | null;
}

export function getQueueAuthToken(env: AppEnv): string | null {
	const queueToken = env.QUEUE_API_TOKEN?.trim();
	if (queueToken) {
		return queueToken;
	}
	const webhookSecret = env.WEBHOOK_SECRET?.trim();
	return webhookSecret ? webhookSecret : null;
}

export function queueRequestAuthorized(request: Request, env: AppEnv): boolean {
	const expected = getQueueAuthToken(env);
	if (!expected) {
		return false;
	}
	const headerToken = request.headers.get('x-queue-token')?.trim();
	if (headerToken && headerToken === expected) {
		return true;
	}
	const authorization = request.headers.get('authorization') ?? '';
	if (authorization.startsWith('Bearer ')) {
		return authorization.slice('Bearer '.length).trim() === expected;
	}
	return false;
}

function getMcpAccessEmail(request: Request): string | null {
	const value = request.headers.get('cf-access-authenticated-user-email')?.trim().toLowerCase();
	return value || null;
}

function getMcpAccessJwtAssertion(request: Request): string | null {
	const value = request.headers.get('cf-access-jwt-assertion')?.trim();
	return value || null;
}

function getEmailDomain(email: string | null): string | null {
	if (!email || !email.includes('@')) {
		return null;
	}
	return email.split('@').pop() ?? null;
}

export function authorizeMcpRequest(request: Request, env: AppEnv): McpAccessAuthResult {
	if (!getMcpRequireAccessAuth(env)) {
		return { ok: true, email: null };
	}

	const email = getMcpAccessEmail(request);
	const jwtAssertion = getMcpAccessJwtAssertion(request);
	if (!email || !jwtAssertion) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			error: 'missing Cloudflare Access identity headers',
		};
	}

	const allowedEmails = getMcpAllowedEmails(env);
	const allowedDomains = getMcpAllowedEmailDomains(env);
	if (allowedEmails.length === 0 && allowedDomains.length === 0) {
		return { ok: true, email };
	}

	const emailDomain = getEmailDomain(email);
	const emailAllowed = allowedEmails.includes(email);
	const domainAllowed = emailDomain !== null && allowedDomains.includes(emailDomain);
	if (emailAllowed || domainAllowed) {
		return { ok: true, email };
	}

	return {
		ok: false,
		status: 403,
		code: 'forbidden',
		error: 'Cloudflare Access identity is not allowed for MCP access',
	};
}
