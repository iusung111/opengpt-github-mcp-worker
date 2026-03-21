import { describe, expect, it } from 'vitest';
import { authorizeMcpRequest, getQueueAuthToken, queueRequestAuthorized } from '../src/auth';
import type { AppEnv } from '../src/types';

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
});
