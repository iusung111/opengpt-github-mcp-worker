import {
	getChatgptMcpAllowedEmails,
	getChatgptMcpAudiences,
	getChatgptMcpIssuer,
	getChatgptMcpJwksJson,
	getChatgptMcpJwksUrl,
	getMcpAllowedEmailDomains,
	getMcpAllowedEmails,
} from '../utils';
import type { AppEnv } from '../contracts';
import type { JwtClaims, JwtHeader } from './types';

const JWKS_CACHE_MS = 5 * 60 * 1000;
const JWT_CLOCK_SKEW_SECONDS = 60;
const USERINFO_CACHE_MS = 10 * 60 * 1000;
const USERINFO_CACHE_LIMIT = 256;
const jwksCache = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();
const userinfoEmailCache = new Map<string, { email: string; expiresAt: number }>();
const userinfoInflight = new Map<string, Promise<string>>();

export function getMcpAccessEmail(request: Request): string | null {
	const value = request.headers.get('cf-access-authenticated-user-email')?.trim().toLowerCase();
	return value || null;
}

export function getMcpAccessJwtAssertion(request: Request): string | null {
	const value = request.headers.get('cf-access-jwt-assertion')?.trim();
	return value || null;
}

export function getEmailDomain(email: string | null): string | null {
	if (!email || !email.includes('@')) return null;
	return email.split('@').pop() ?? null;
}

export function getBearerToken(request: Request): string | null {
	const authorization = request.headers.get('authorization')?.trim() ?? '';
	if (!authorization.startsWith('Bearer ')) return null;
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

function getCachedUserinfoEmail(token: string): string | null {
	const cached = userinfoEmailCache.get(token);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		userinfoEmailCache.delete(token);
		return null;
	}
	return cached.email;
}

function cacheUserinfoEmail(token: string, email: string): void {
	let expiresAt = Date.now() + USERINFO_CACHE_MS;
	try {
		const { claims } = parseJwt(token);
		if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
			expiresAt = Math.min(expiresAt, claims.exp * 1000);
		}
	} catch {
		// Opaque tokens do not expose a JWT expiry segment.
	}
	if (expiresAt <= Date.now()) expiresAt = Date.now() + 30_000;
	userinfoEmailCache.set(token, { email, expiresAt });
	while (userinfoEmailCache.size > USERINFO_CACHE_LIMIT) {
		const oldestKey = userinfoEmailCache.keys().next().value;
		if (!oldestKey) break;
		userinfoEmailCache.delete(oldestKey);
	}
}

export function parseJwt(token: string): { header: JwtHeader; claims: JwtClaims; signingInput: string; signature: Uint8Array } {
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
	if (!issuer) throw new Error('ChatGPT MCP issuer is not configured');
	if (claims.iss !== issuer) throw new Error('invalid token issuer');
	const allowedAudiences = getChatgptMcpAudiences(env);
	if (allowedAudiences.length === 0) throw new Error('ChatGPT MCP audience is not configured');
	const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
	if (!tokenAudiences.some((audience) => allowedAudiences.includes(audience))) throw new Error('invalid token audience');
	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.nbf === 'number' && claims.nbf > now + JWT_CLOCK_SKEW_SECONDS) throw new Error('token not active yet');
	if (typeof claims.exp !== 'number' || claims.exp <= now - JWT_CLOCK_SKEW_SECONDS) throw new Error('token expired');
	const email = claims.email?.trim().toLowerCase();
	return email || null;
}

function parseJwksPayload(payloadText: string): JsonWebKey[] {
	const parsed = JSON.parse(payloadText) as { keys?: JsonWebKey[] } | JsonWebKey[];
	if (Array.isArray(parsed)) return parsed;
	if (Array.isArray(parsed.keys)) return parsed.keys;
	throw new Error('invalid JWKS payload');
}

async function getJwksKeys(env: AppEnv): Promise<JsonWebKey[]> {
	const inlineJson = getChatgptMcpJwksJson(env);
	if (inlineJson) return parseJwksPayload(inlineJson);
	const jwksUrl = getChatgptMcpJwksUrl(env);
	if (!jwksUrl) throw new Error('ChatGPT MCP JWKS is not configured');
	const cached = jwksCache.get(jwksUrl);
	if (cached && cached.expiresAt > Date.now()) return cached.keys;
	const response = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
	if (!response.ok) throw new Error(`failed to fetch JWKS: ${response.status}`);
	const payloadText = await response.text();
	const keys = parseJwksPayload(payloadText);
	jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + JWKS_CACHE_MS });
	return keys;
}

function selectVerificationKey(header: JwtHeader, keys: JsonWebKey[]): JsonWebKey {
	const rsaKeys = keys.filter((key) => key.kty === 'RSA');
	if (rsaKeys.length === 0) throw new Error('no RSA verification keys available');
	if (header.kid) {
		const keyed = rsaKeys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
		if (!keyed) throw new Error('verification key not found');
		return keyed;
	}
	if (rsaKeys.length === 1) return rsaKeys[0];
	throw new Error('verification key is ambiguous');
}

async function fetchUserinfoEmailUncached(token: string, env: AppEnv): Promise<string> {
	const issuer = getChatgptMcpIssuer(env);
	if (!issuer) throw new Error('ChatGPT MCP issuer is not configured');
	const userinfoUrl = new URL('/userinfo', issuer).toString();
	const response = await fetch(userinfoUrl, {
		headers: { accept: 'application/json', authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`failed to fetch userinfo: ${response.status}`);
	const payload = (await response.json()) as { email?: string };
	const email = payload.email?.trim().toLowerCase();
	if (!email) throw new Error('token email claim missing');
	cacheUserinfoEmail(token, email);
	return email;
}

export async function fetchUserinfoEmail(token: string, env: AppEnv): Promise<string> {
	const cachedEmail = getCachedUserinfoEmail(token);
	if (cachedEmail) return cachedEmail;
	const inflight = userinfoInflight.get(token);
	if (inflight) return inflight;
	const requestPromise = fetchUserinfoEmailUncached(token, env);
	userinfoInflight.set(token, requestPromise);
	try {
		return await requestPromise;
	} finally {
		userinfoInflight.delete(token);
	}
}

export async function verifyBearerIdentity(token: string, env: AppEnv): Promise<string> {
	try {
		const { header, claims, signingInput, signature } = parseJwt(token);
		if (!['RS256', 'RS384', 'RS512'].includes(header.alg ?? '')) throw new Error('unsupported token algorithm');
		const algorithm =
			header.alg === 'RS512'
				? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }
				: header.alg === 'RS384'
					? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }
					: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
		const keys = await getJwksKeys(env);
		const jwk = selectVerificationKey(header, keys);
		const cryptoKey = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
		const valid = await crypto.subtle.verify(algorithm, cryptoKey, signature, new TextEncoder().encode(signingInput));
		if (!valid) throw new Error('invalid token signature');
		return assertJwtClaims(claims, env) ?? (await fetchUserinfoEmail(token, env));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === 'invalid bearer token') return fetchUserinfoEmail(token, env);
		throw error;
	}
}

export function getAccessAllowlist(env: AppEnv): { emails: string[]; domains: string[] } {
	return { emails: getMcpAllowedEmails(env), domains: getMcpAllowedEmailDomains(env) };
}

export function getChatgptAllowlist(env: AppEnv): string[] {
	return getChatgptMcpAllowedEmails(env);
}
