import { describe, expect, it } from 'vitest';
import {
	buildConfirmToken,
	buildStableBrowserSessionId,
	buildStablePreviewId,
	decodeToken,
	encodeToken,
	validateConfirmToken,
} from '../src/state-tokens';
import { AppEnv } from '../src/contracts';

const tokenEnv = {
	WEBHOOK_SECRET: 'test-webhook-secret',
} as AppEnv;

describe('state tokens', () => {
	it('round-trips preview tokens including healthcheck metadata', async () => {
		const previewId = await buildStablePreviewId('iusung111/OpenGPT', 'agent/demo');
		const token = await encodeToken(tokenEnv, {
			type: 'preview',
			preview_id: previewId,
			repo: 'iusung111/OpenGPT',
			ref: 'agent/demo',
			status: 'ready',
			urls: { web: 'https://preview.example.com' },
			expires_at: '2099-01-01T00:00:00.000Z',
			created_at: '2099-01-01T00:00:00.000Z',
			healthcheck_path: '/healthz',
		});
		await expect(decodeToken(tokenEnv, token, 'preview')).resolves.toMatchObject({
			preview_id: previewId,
			healthcheck_path: '/healthz',
		});
	});

	it('rejects tampered preview tokens', async () => {
		const token = await encodeToken(tokenEnv, {
			type: 'preview',
			preview_id: 'pv_demo',
			repo: 'iusung111/OpenGPT',
			ref: 'agent/demo',
			status: 'ready',
			urls: { web: 'https://preview.example.com' },
			expires_at: '2099-01-01T00:00:00.000Z',
			created_at: '2099-01-01T00:00:00.000Z',
		});
		const tampered = `${token.slice(0, -1)}x`;
		await expect(decodeToken(tokenEnv, tampered, 'preview')).rejects.toThrow('invalid token signature');
	});

	it('rejects expired tokens', async () => {
		const token = await encodeToken(tokenEnv, {
			type: 'preview',
			preview_id: 'pv_demo',
			repo: 'iusung111/OpenGPT',
			ref: 'agent/demo',
			status: 'ready',
			urls: { web: 'https://preview.example.com' },
			expires_at: '2000-01-01T00:00:00.000Z',
			created_at: '1999-12-31T23:59:59.000Z',
		});
		await expect(decodeToken(tokenEnv, token, 'preview')).rejects.toThrow('token expired');
	});

	it('issues confirm tokens scoped to one action and ref', async () => {
		const issued = await buildConfirmToken(tokenEnv, {
			action: 'db_reset',
			repo: 'iusung111/OpenGPT',
			ref: 'agent/demo',
			ttl_minutes: 5,
		});
		await expect(
			validateConfirmToken(tokenEnv, {
				token: issued.token,
				action: 'db_reset',
				repo: 'iusung111/OpenGPT',
				ref: 'agent/demo',
			}),
		).resolves.toMatchObject({
			action: 'db_reset',
			repo: 'iusung111/OpenGPT',
			ref: 'agent/demo',
		});
		await expect(
			validateConfirmToken(tokenEnv, {
				token: issued.token,
				action: 'db_reset',
				repo: 'iusung111/OpenGPT',
				ref: 'main',
			}),
		).rejects.toThrow('confirm token does not match the requested action');
	});

	it('builds deterministic browser session ids', async () => {
		await expect(buildStableBrowserSessionId('https://preview.example.com')).resolves.toBe(
			await buildStableBrowserSessionId('https://preview.example.com'),
		);
	});
});

