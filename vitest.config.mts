import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configureLocalWorkerdPaths } from './worker/scripts/local-workerd-paths.mjs';

configureLocalWorkerdPaths();

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				isolatedStorage: false,
				miniflare: {
					// workerd SQLite-backed DO storage is unstable on Windows hosts.
					// Keep Linux/CI on disk-backed storage, but use ephemeral DO state locally on Windows.
					unsafeEphemeralDurableObjects: process.platform === 'win32',
					bindings: {
						WEBHOOK_SECRET: 'test-webhook-secret',
						GITHUB_APP_PRIVATE_KEY_PEM: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCf8II/y/p6qOz4
y8DrkZKvb1TEv7/MvOX89XPLCDthe1j4fqbhdk7ECizoBkq9CfgAMHEYRrmQNeDH
ddi+oC4OcHlpwL8i6onW2zvpIlQZpN5j+gC7fiBSdLedXqcMC/dV91SdUdOmkcWw
L8cpYOxbfN81RlI6CMW1rHRDk/PxAoXTYFFgAjovmfD2IT/ZZeSE4HXwHNWQvu+E
9wMfFHWdgqerOlAqkEWT6sfpVCPCCfl/Ou9nY6OTMJfw0qGekn+1doXmdQfQJyF9
mRE66QFXV70diPxMdMPaL10tC693XcgCa6UZ9BjjtUJQQSmN5h6VDyCTLcQYSf0J
hjk8LBbZAgMBAAECggEAAa5Z+B4GknPPFdMHwpIY9sNr99YaHSaedjkFkAyUmd2I
MwhwbEM9kwhBA5P5WiD43ID7LKmlo/3k+xkNKlJtrtTWJIXpnGOBsmKYhRv0GAGT
HX2QX2gfzS4RNf67hmq5HUwIYCTu3WZ/1kO89f2Lo8SIELvIpnfWzXuJYffJTcRY
Q2FJ0CsK6uMVv4uVhQIkDIuGzbsuJwIWRDrvs9GZjfKqFPAiL2hJMSf7Xui/B+mo
W5oVcJDZGLKFm+cRwA/pJ9y3psoN2CmGBdCZ7/9mh3cJjOTuKWmaUCilOwaO4OLo
EefOj2eJbPx/ztf4xn+deFUTImbTHmjVi/AIrM31/wKBgQDTpPlOvwBT7nWj3FbF
MQrruBmDc3Zx0wViFRGXKE5gAXZi0qk3MRKUd2b4dMkHO+Dfz55vL+BFyYNVcxYo
WVicJOYt4mUOKQTIASBR8CIvLkveVQDIZh44p4BnMXUT/LDFEfFMmDg0DEXrgRSH
351cytAYHgw2jW92iUqMRuKxIwKBgQDBdX2rrkEb2+4da42Bb85Yfaarp7Rel4rf
BMmir71WAoo+rQEp/jWOYmGMGr+JC/GgABf+pMsIepjEeGeurRo3410NUCw7eicM
3S01v1jN/5VfVdNQ0orsaMXbqAwVBu1Sart1OwYZi1aD9dhZKNfZ54cFLve8SEj7
SBXJwjJ90wKBgBcDOzB6yDhYF2aH0M+EM6HJ1MxcQ6bAwTcW/2CmO09pGUxJh6i+
pzyJdyLQ4ALvWdY8JwgD9qjf7m3eI6yjemUQBg87LK3Le/+bT75ZE/55VDqKl5ky
sVqLrASMdiSEN1xWRRyE+KeAJiIjWO4lPGEYlGPq8H0GB/almvuBwahtAoGAA84U
x7CotSyRNWDtKpORYmouQggNYyLl51cHxDxio/Nu1qa+dB383a0PsBrCk6Z5fSUj
U63YFHWc1ZhsqaHb9ydwqBdgl1bit70N65W04HBbdsGQY3GQq++vnI9klXFKb6mL
wFWF3DDCZdwLAk3sWOvV2wM+eiSN0utrCknYhmMCgYEAr0XJYdHSa2WUU0O+dDHN
+0Ve6+Ei/ajr6PqEt0insgL947VARkepnM07R5vSnAX9Yw7UACvsHVrOPvDZxczy
K9+gf+A3EShgPx3IBp1EQz3m9yCNRuY6IQqADgm4ycYuRAvYig24yOH8Fjv9nFvQ
+LvmPzMZUVmwTFUXQecDtSw=
-----END PRIVATE KEY-----`,
						WORKING_STALE_AFTER_MS: '20',
						REVIEW_STALE_AFTER_MS: '20',
						DISPATCH_DEDUPE_WINDOW_MS: '1000',
						AUDIT_RETENTION_COUNT: '5',
						DELIVERY_RETENTION_COUNT: '3',
						CHATGPT_MCP_AUTH_MODE: 'oidc',
						CHATGPT_MCP_ISSUER: 'https://auth.example.com',
						CHATGPT_MCP_AUDIENCE: 'chatgpt-mcp-worker',
						CHATGPT_MCP_JWKS_JSON:
							'{"keys":[{"kty":"RSA","kid":"chatgpt-test-rs256","use":"sig","alg":"RS256","n":"n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q","e":"AQAB"}]}',
						CHATGPT_MCP_ALLOWED_EMAILS: 'developer@example.com',
						GUI_OIDC_CLIENT_ID: 'spa-client-id',
					},
				},
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
