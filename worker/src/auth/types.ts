export interface McpAccessAuthResult {
	ok: boolean;
	status?: number;
	code?: string;
	error?: string;
	email?: string | null;
	auth_type?: 'access' | 'bearer' | 'none';
}

export interface JwtHeader {
	alg?: string;
	kid?: string;
	typ?: string;
}

export interface JwtClaims {
	iss?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	email?: string;
}
