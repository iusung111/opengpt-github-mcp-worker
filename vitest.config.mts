import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				isolatedStorage: false,
				miniflare: {
					bindings: {
						WEBHOOK_SECRET: 'test-webhook-secret',
						WORKING_STALE_AFTER_MS: '20',
						REVIEW_STALE_AFTER_MS: '20',
						DISPATCH_DEDUPE_WINDOW_MS: '1000',
						AUDIT_RETENTION_COUNT: '5',
						DELIVERY_RETENTION_COUNT: '3',
					},
				},
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
