import { describe, expect, it, vi } from 'vitest';
import {
	authorizeChatgptMcpRequest,
	authorizeDirectMcpRequest,
	authorizeGuiOperatorRequest,
	authorizeMcpRequest,
	getQueueAuthToken,
	queueRequestAuthorized,
} from '../src/auth';
import type { AppEnv } from '../src/types';
import { signChatgptOidcToken } from './jwt-helpers';

function buildEnv(values: Partial<AppEnv>): AppEnv {
	return values as AppEnv;
}

describe('queue auth', () => {
	it('prefers QUEUE_API_TOKEN over WEBHOOK_SECRET', () => {
		const env = buildEnv({
			QUEUE_API_TOKEN: 'queue-token',
			WEBHOOK_SECRET: 'webhook-secret',
		});
		expect(getQueueAuthToken(env)).toBe('queue-token');
	});

	it('falls back to WEBHOOK_SECRET when QUEUE_API_TOKEN is unset', () => {
		const env = buildEnv({
			WEBHOOK_SECRET: 'webhook-secret',
		});
		expect(getQueueAuthToken(env)).toBe('webhook-secret');
	});

	it('accepts x-queue-token header', () => {
		const env = buildEnv({
			QUEUE_API_TOKEN: 'queue-token',
		});
		const request = new Request('https://example.com/queue/jobs', {
			headers: { 'x-queue-token': 'queue-token' },
		});
		expect(queueRequestAuthorized(request, env)).toBe(true);
	});

	it('accepts bearer token header', () => {
		const env = buildEnv({
			QUEUE_API_TOKEN: 'queue-token',
		});
		const request = new Request('https://example.com/queue/jobs', {
			headers: { authorization: 'Bearer queue-token' },
		});
		expect(queueRequestAuthorized(request, env)).toBe(true);
	});
});

describe('mcp access auth', () => {
	it('allows MCP requests when Access auth is disabled', () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'false',
		});
		const request = new Request('https://example.com/mcp');
		expect(authorizeMcpRequest(request, env)).toMatchObject({ ok: true });
	});

	it('rejects MCP requests when required Access headers are missing', () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'true',
		});
		const request = new Request('https://example.com/mcp');
		expect(authorizeMcpRequest(request, env)).toMatchObject({
			ok: false,
			status: 401,
			code: 'unauthorized',
		});
	});

	it('allows a valid Access-authenticated request with a matching email', () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'true',
			MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const request = new Request('https://example.com/mcp', {
			headers: {
				'cf-access-authenticated-user-email': 'developer@example.com',
				'cf-access-jwt-assertion': 'signed-jwt',
			},
		});
		expect(authorizeMcpRequest(request, env)).toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
	});

	it('allows a valid Access-authenticated request with a matching domain', () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'true',
			MCP_ALLOWED_EMAIL_DOMAINS: 'example.com',
		});
		const request = new Request('https://example.com/mcp', {
			headers: {
				'cf-access-authenticated-user-email': 'developer@example.com',
				'cf-access-jwt-assertion': 'signed-jwt',
			},
		});
		expect(authorizeMcpRequest(request, env)).toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
	});

	it('rejects an authenticated request outside the configured allowlist', () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'true',
			MCP_ALLOWED_EMAILS: 'owner@example.com',
			MCP_ALLOWED_EMAIL_DOMAINS: 'example.org',
		});
		const request = new Request('https://example.com/mcp', {
			headers: {
				'cf-access-authenticated-user-email': 'developer@example.com',
				'cf-access-jwt-assertion': 'signed-jwt',
			},
		});
		expect(authorizeMcpRequest(request, env)).toMatchObject({
			ok: false,
			status: 403,
			code: 'forbidden',
		});
	});

	it('allows a valid ChatGPT bearer token on the direct /mcp route when oidc auth is configured', async () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'true',
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const token = await signChatgptOidcToken();
		const request = new Request('https://example.com/mcp', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeDirectMcpRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
	});

	it('requires explicit auth for the standalone GUI operator API', async () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'false',
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const request = new Request('https://example.com/gui/api/session');
		await expect(authorizeGuiOperatorRequest(request, env)).resolves.toMatchObject({
			ok: false,
			status: 401,
			code: 'unauthorized',
		});
	});

	it('allows Cloudflare Access identity for the standalone GUI operator API', async () => {
		const env = buildEnv({
			MCP_REQUIRE_ACCESS_AUTH: 'true',
			MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const request = new Request('https://example.com/gui/api/session', {
			headers: {
				'cf-access-authenticated-user-email': 'developer@example.com',
				'cf-access-jwt-assertion': 'signed-jwt',
			},
		});
		await expect(authorizeGuiOperatorRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
			auth_type: 'access',
		});
	});

	it('allows a valid bearer token for the standalone GUI operator API', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const token = await signChatgptOidcToken();
		const request = new Request('https://example.com/gui/api/session', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeGuiOperatorRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
			auth_type: 'bearer',
		});
	});
});

describe('chatgpt mcp oidc auth', () => {
	it('rejects requests without a bearer token', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const request = new Request('https://example.com/chatgpt/mcp');
		await expect(authorizeChatgptMcpRequest(request, env)).resolves.toMatchObject({
			ok: false,
			status: 401,
			code: 'unauthorized',
			error: 'missing bearer token',
		});
	});

	it('allows a valid bearer token with a matching email', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const token = await signChatgptOidcToken();
		const request = new Request('https://example.com/chatgpt/mcp', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeChatgptMcpRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
	});

	it('falls back to the userinfo endpoint when the access token omits email', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const token = 'opaque-userinfo-token';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === 'https://auth.example.com/userinfo') {
					return new Response(JSON.stringify({ email: 'developer@example.com' }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const request = new Request('https://example.com/chatgpt/mcp', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeChatgptMcpRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
		vi.unstubAllGlobals();
	});

	it('caches userinfo lookups for repeated bearer auth checks', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		const token = 'opaque-userinfo-token-cached';
		let userinfoCalls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === 'https://auth.example.com/userinfo') {
					userinfoCalls += 1;
					return new Response(JSON.stringify({ email: 'developer@example.com' }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					});
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const request = new Request('https://example.com/gui/api/session', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeGuiOperatorRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
		await expect(authorizeGuiOperatorRequest(request, env)).resolves.toMatchObject({
			ok: true,
			email: 'developer@example.com',
		});
		expect(userinfoCalls).toBe(1);
		vi.unstubAllGlobals();
	});

	it('rejects a bearer token outside the allowlist', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_JSON:
				'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
			CHATGPT_MCP_ALLOWED_EMAILS: 'owner@example.com',
		});
		const token = await signChatgptOidcToken({ email: 'developer@example.com' });
		const request = new Request('https://example.com/chatgpt/mcp', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeChatgptMcpRequest(request, env)).resolves.toMatchObject({
			ok: false,
			status: 403,
			code: 'forbidden',
		});
	});

	it('rejects a token with the wrong audience', async () => {
		const env = buildEnv({
			CHATGPT_MCP_AUTH_MODE: 'oidc',
			CHATGPT_MCP_ISSUER: 'https://auth.example.com',
			CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
			CHATGPT_MCP_JWKS_URL: 'https://issuer.example.com/jwks',
			CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
			),
		);
		const token = await signChatgptOidcToken({ audience: 'different-audience' });
		const request = new Request('https://example.com/chatgpt/mcp', {
			headers: { authorization: `Bearer ${token}` },
		});
		await expect(authorizeChatgptMcpRequest(request, env)).resolves.toMatchObject({
			ok: false,
			status: 401,
			code: 'unauthorized',
			error: 'invalid token audience',
		});
		vi.unstubAllGlobals();
	});
});
