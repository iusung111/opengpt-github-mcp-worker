import { AppEnv } from './types';
import {
	getChatgptMcpAllowedEmails,
	getChatgptMcpAudiences,
	getChatgptMcpAuthMode,
	getChatgptMcpIssuer,
	getChatgptMcpJwksJson,
	getChatgptMcpJwksUrl,
	getMcpAllowedEmailDomains,
	getMcpAllowedEmails,
	getMcpRequireAccessAuth,
} from './utils';

export interface McpAccessAuthResult {
	ok: boolean;
	status?: number;
	code?: string;
	error?: string;
	email?: string | null;
	auth_type?: 'access' | 'bearer' | 'none';
}

interface JwtHeader {
	alg?: string;
	kid?: string;
	typ?: string;
}

interface JwtClaims {
	iss?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	email?: string;
}

const JWKS_CACHE_MS = 5 * 60 * 1000;
const JWT_CLOCK_SKEW_SECONDS = 60;
const jwksCache = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();

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

function getBearerToken(request: Request): string | null {
	const authorization = request.headers.get('authorization')?.trim() ?? '';
	if (!authorization.startsWith('Bearer ')) {
		return null;
	}
	const token = authorization.slice('Bearer '.length).trim();
	return token || null;
}

function decodeBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJwtJson<T>(segment: string): T {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))) as T;
}

function parseJwt(token: string): { header: JwtHeader; claims: JwtClaims; signingInput: string; signature: Uint8Array } {
	const parts = token.split('.');
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
		throw new Error('invalid bearer token');
	}
	return {
		header: decodeJwtJson<JwtHeader>(parts[0]),
		claims: decodeJwtJson<JwtClaims>(parts[1]),
		signingInput: `${parts[0]}.${parts[1]}`,
		signature: decodeBase64Url(parts[2]),
	};
}

function assertJwtClaims(claims: JwtClaims, env: AppEnv): string | null {
	const issuer = getChatgptMcpIssuer(env);
	if (!issuer) {
		throw new Error('ChatGPT MCP issuer is not configured');
	}
	if (claims.iss !== issuer) {
		throw new Error('invalid token issuer');
	}

	const allowedAudiences = getChatgptMcpAudiences(env);
	if (allowedAudiences.length === 0) {
		throw new Error('ChatGPT MCP audience is not configured');
	}
	const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
	if (!tokenAudiences.some((audience) => allowedAudiences.includes(audience))) {
		throw new Error('invalid token audience');
	}

	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.nbf === 'number' && claims.nbf > now + JWT_CLOCK_SKEW_SECONDS) {
		throw new Error('token not active yet');
	}
	if (typeof claims.exp !== 'number' || claims.exp <= now - JWT_CLOCK_SKEW_SECONDS) {
		throw new Error('token expired');
	}

	const email = claims.email?.trim().toLowerCase();
	return email || null;
}

function parseJwksPayload(payloadText: string): JsonWebKey[] {
	const parsed = JSON.parse(payloadText) as { keys?: JsonWebKey[] } | JsonWebKey[];
	if (Array.isArray(parsed)) {
		return parsed;
	}
	if (Array.isArray(parsed.keys)) {
		return parsed.keys;
	}
	throw new Error('invalid JWKS payload');
}

async function getJwksKeys(env: AppEnv): Promise<JsonWebKey[]> {
	const inlineJson = getChatgptMcpJwksJson(env);
	if (inlineJson) {
		return parseJwksPayload(inlineJson);
	}

	const jwksUrl = getChatgptMcpJwksUrl(env);
	if (!jwksUrl) {
		throw new Error('ChatGPT MCP JWKS is not configured');
	}

	const cached = jwksCache.get(jwksUrl);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.keys;
	}

	const response = await fetch(jwksUrl, {
		headers: { accept: 'application/json' },
	});
	if (!response.ok) {
		throw new Error(`failed to fetch JWKS: ${response.status}`);
	}
	const payloadText = await response.text();
	const keys = parseJwksPayload(payloadText);
	jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + JWKS_CACHE_MS });
	return keys;
}

function selectVerificationKey(header: JwtHeader, keys: JsonWebKey[]): JsonWebKey {
	const rsaKeys = keys.filter((key) => key.kty === 'RSA');
	if (rsaKeys.length === 0) {
		throw new Error('no RSA verification keys available');
	}
	if (header.kid) {
		const keyed = rsaKeys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
		if (!keyed) {
			throw new Error('verification key not found');
		}
		return keyed;
	}
	if (rsaKeys.length === 1) {
		return rsaKeys[0];
	}
	throw new Error('verification key is ambiguous');
}

async function verifyJwtSignature(token: string, env: AppEnv): Promise<string> {
	const { header, claims, signingInput, signature } = parseJwt(token);
	if (!['RS256', 'RS384', 'RS512'].includes(header.alg ?? '')) {
		throw new Error('unsupported token algorithm');
	}

	const algorithm =
		header.alg === 'RS512'
			? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }
			: header.alg === 'RS384'
				? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }
				: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
	const keys = await getJwksKeys(env);
	const jwk = selectVerificationKey(header, keys);
	const cryptoKey = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
	const valid = await crypto.subtle.verify(
		algorithm,
		cryptoKey,
		signature,
		new TextEncoder().encode(signingInput),
	);
	if (!valid) {
		throw new Error('invalid token signature');
	}

	const claimEmail = assertJwtClaims(claims, env);
	if (claimEmail) {
		return claimEmail;
	}

	return fetchUserinfoEmail(token, env);
}

async function fetchUserinfoEmail(token: string, env: AppEnv): Promise<string> {
	const issuer = getChatgptMcpIssuer(env);
	if (!issuer) {
		throw new Error('ChatGPT MCP issuer is not configured');
	}
	const userinfoUrl = new URL('/userinfo', issuer).toString();
	const response = await fetch(userinfoUrl, {
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok) {
		throw new Error(`failed to fetch userinfo: ${response.status}`);
	}
	const payload = (await response.json()) as { email?: string };
	const email = payload.email?.trim().toLowerCase();
	if (!email) {
		throw new Error('token email claim missing');
	}
	return email;
}

async function verifyBearerIdentity(token: string, env: AppEnv): Promise<string> {
	try {
		return await verifyJwtSignature(token, env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === 'invalid bearer token') {
			return fetchUserinfoEmail(token, env);
		}
		throw error;
	}
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

export async function authorizeDirectMcpRequest(
	request: Request,
	env: AppEnv,
): Promise<McpAccessAuthResult> {
	const accessHeadersPresent = Boolean(getMcpAccessEmail(request) || getMcpAccessJwtAssertion(request));
	if (accessHeadersPresent) {
		return authorizeMcpRequest(request, env);
	}

	const bearerToken = getBearerToken(request);
	if (!bearerToken) {
		return authorizeMcpRequest(request, env);
	}

	if (getChatgptMcpAuthMode(env) === 'disabled') {
		return authorizeMcpRequest(request, env);
	}

	return authorizeChatgptMcpRequest(request, env);
}

export async function authorizeChatgptMcpRequest(request: Request, env: AppEnv): Promise<McpAccessAuthResult> {
	if (getChatgptMcpAuthMode(env) === 'disabled') {
		return {
			ok: false,
			status: 503,
			code: 'server_error',
			error: 'ChatGPT MCP OIDC auth is not configured',
		};
	}

	const token = getBearerToken(request);
	if (!token) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			error: 'missing bearer token',
		};
	}

	let email: string;
	try {
		email = await verifyBearerIdentity(token, env);
	} catch (error) {
		return {
			ok: false,
			status: 401,
			code: 'unauthorized',
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const allowedEmails = getChatgptMcpAllowedEmails(env);
	if (allowedEmails.length === 0) {
		return {
			ok: false,
			status: 403,
			code: 'forbidden',
			error: 'ChatGPT MCP identity allowlist is empty',
		};
	}
	if (!allowedEmails.includes(email)) {
		return {
			ok: false,
			status: 403,
			code: 'forbidden',
			error: 'ChatGPT MCP identity is not allowed',
		};
	}

	return { ok: true, email };
}

export async function authorizeGuiOperatorRequest(
	request: Request,
	env: AppEnv,
): Promise<McpAccessAuthResult> {
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

	if (!getMcpRequireAccessAuth(env) && getChatgptMcpAuthMode(env) === 'disabled') {
		return { ok: true, email: null, auth_type: 'none' };
	}

	return {
		ok: false,
		status: 401,
		code: 'unauthorized',
		error: 'GUI operator auth requires Cloudflare Access or a bearer token',
	};
}
