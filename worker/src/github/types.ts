export interface InstallationToken {
	token: string;
	expires_at: string;
}

export interface GitHubRequestOptions {
	params?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
}

export interface ResolvedGitHubCredentials {
	appId: string;
	installationId: string;
	privateKeyPem: string;
	source: 'default' | 'mirror';
}

export type GitHubEnv = Env & {
	GITHUB_APP_PRIVATE_KEY_PEM?: string;
	GITHUB_API_URL?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	SELF_DEPLOY_ENV?: string;
	MIRROR_GITHUB_APP_ID?: string;
	MIRROR_GITHUB_APP_INSTALLATION_ID?: string;
	MIRROR_GITHUB_APP_PRIVATE_KEY_PEM?: string;
};
