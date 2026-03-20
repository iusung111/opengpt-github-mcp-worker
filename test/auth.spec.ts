import { describe, expect, it } from 'vitest';
import { getQueueAuthToken, queueRequestAuthorized } from '../src/auth';
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
