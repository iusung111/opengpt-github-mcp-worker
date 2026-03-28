import { describe, expect, it } from 'vitest';
import {
	buildStableBrowserSessionId,
	buildStablePreviewId,
	decodeToken,
	encodeToken,
} from '../src/state-tokens';

describe('state tokens', () => {
	it('round-trips preview tokens including healthcheck metadata', async () => {
		const previewId = await buildStablePreviewId('iusung111/OpenGPT', 'agent/demo');
		const token = encodeToken({
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
		expect(decodeToken(token, 'preview')).toMatchObject({
			preview_id: previewId,
			healthcheck_path: '/healthz',
		});
	});

	it('builds deterministic browser session ids', async () => {
		await expect(buildStableBrowserSessionId('https://preview.example.com')).resolves.toBe(
			await buildStableBrowserSessionId('https://preview.example.com'),
		);
	});
});
