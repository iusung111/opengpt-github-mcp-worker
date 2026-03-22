const chatgptPrivateJwk: JsonWebKey = {
	kty: 'RSA',
	kid: 'chatgpt-test-rs256',
	use: 'sig',
	alg: 'RS256',
	n: 'n_CCP8v6eqjs-MvA65GSr29UxL-_zLzl_PVzywg7YXtY-H6m4XZOxAos6AZKvQn4ADBxGEa5kDXgx3XYvqAuDnB5acC_IuqJ1ts76SJUGaTeY_oAu34gUnS3nV6nDAv3VfdUnVHTppHFsC_HKWDsW3zfNUZSOgjFtax0Q5Pz8QKF02BRYAI6L5nw9iE_2WXkhOB18BzVkL7vhPcDHxR1nYKnqzpQKpBFk-rH6VQjwgn5fzrvZ2OjkzCX8NKhnpJ_tXaF5nUH0CchfZkROukBV1e9HYj8THTD2i9dLQuvd13IAmulGfQY47VCUEEpjeYelQ8gky3EGEn9CYY5PCwW2Q',
	e: 'AQAB',
	d: 'Aa5Z-B4GknPPFdMHwpIY9sNr99YaHSaedjkFkAyUmd2IMwhwbEM9kwhBA5P5WiD43ID7LKmlo_3k-xkNKlJtrtTWJIXpnGOBsmKYhRv0GAGTHX2QX2gfzS4RNf67hmq5HUwIYCTu3WZ_1kO89f2Lo8SIELvIpnfWzXuJYffJTcRYQ2FJ0CsK6uMVv4uVhQIkDIuGzbsuJwIWRDrvs9GZjfKqFPAiL2hJMSf7Xui_B-moW5oVcJDZGLKFm-cRwA_pJ9y3psoN2CmGBdCZ7_9mh3cJjOTuKWmaUCilOwaO4OLoEefOj2eJbPx_ztf4xn-deFUTImbTHmjVi_AIrM31_w',
	p: '06T5Tr8AU-51o9xWxTEK67gZg3N2cdMFYhURlyhOYAF2YtKpNzESlHdm-HTJBzvg38-eby_gRcmDVXMWKFlYnCTmLeJlDikEyAEgUfAiLy5L3lUAyGYeOKeAZzF1E_ywxRHxTJg4NAxF64EUh9-dXMrQGB4MNo1vdolKjEbisSM',
	q: 'wXV9q65BG9vuHWuNgW_OWH2mq6e0XpeK3wTJoq-9VgKKPq0BKf41jmJhjBq_iQvxoAAX_qTLCHqYxHhnrq0aN-NdDVAsO3onDN0tNb9Yzf-VX1XTUNKK7GjF26gMFQbtUmq7dTsGGYtWg_XYWSjX2eeHBS73vEhI-0gVycIyfdM',
	dp: 'FwM7MHrIOFgXZofQz4QzocnUzFxDpsDBNxb_YKY7T2kZTEmHqL6nPIl3ItDgAu9Z1jwnCAP2qN_ubd4jrKN6ZRAGDzssrct7_5tPvlkT_nlUOoqXmTKxWousBIx2JIQ3XFZFHIT4p4AmIiNY7iU8YRiUY-rwfQYH9qWa-4HBqG0',
	dq: 'A84Ux7CotSyRNWDtKpORYmouQggNYyLl51cHxDxio_Nu1qa-dB383a0PsBrCk6Z5fSUjU63YFHWc1ZhsqaHb9ydwqBdgl1bit70N65W04HBbdsGQY3GQq--vnI9klXFKb6mLwFWF3DDCZdwLAk3sWOvV2wM-eiSN0utrCknYhmM',
	qi: 'r0XJYdHSa2WUU0O-dDHN-0Ve6-Ei_ajr6PqEt0insgL947VARkepnM07R5vSnAX9Yw7UACvsHVrOPvDZxczyK9-gf-A3EShgPx3IBp1EQz3m9yCNRuY6IQqADgm4ycYuRAvYig24yOH8Fjv9nFvQ-LvmPzMZUVmwTFUXQecDtSw',
};

function base64UrlEncode(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function signChatgptOidcToken(overrides: {
	email?: string;
	issuer?: string;
	audience?: string | string[];
	expiresInSeconds?: number;
} = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = {
		alg: 'RS256',
		typ: 'JWT',
		kid: 'chatgpt-test-rs256',
	};
	const payload = {
		iss: overrides.issuer ?? 'https://auth.example.com',
		aud: overrides.audience ?? 'chatgpt-mcp-worker',
		email: overrides.email ?? 'developer@example.com',
		nbf: now - 30,
		exp: now + (overrides.expiresInSeconds ?? 300),
	};
	const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
	const key = await crypto.subtle.importKey(
		'jwk',
		chatgptPrivateJwk,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}
