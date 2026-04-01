import { AppEnv } from '../types';
import { hasRecord } from './common';
import workflowAllowlistConfig from '../workflow-allowlist-config';

export function parseCsv(value: string | undefined): string[] {
	return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function parseCsvLower(value: string | undefined): string[] {
	return parseCsv(value).map((item) => item.toLowerCase());
}

export function getAllowedRepos(env: AppEnv): string[] {
	return parseCsv(env.GITHUB_ALLOWED_REPOS);
}

export function getMcpRequireAccessAuth(env: AppEnv): boolean {
	return env.MCP_REQUIRE_ACCESS_AUTH?.trim().toLowerCase() !== 'false';
}

export function getMcpAllowedEmails(env: AppEnv): string[] {
	return parseCsvLower(env.MCP_ALLOWED_EMAILS);
}

export function getMcpAllowedEmailDomains(env: AppEnv): string[] {
	return parseCsvLower(env.MCP_ALLOWED_EMAIL_DOMAINS).map((item) => item.replace(/^@+/, ''));
}

export function getMcpAccessMode(env: AppEnv): 'disabled' | 'any_authenticated_user' | 'email_or_domain_allowlist' {
	if (!getMcpRequireAccessAuth(env)) {
		return 'disabled';
	}
	if (getMcpAllowedEmails(env).length > 0 || getMcpAllowedEmailDomains(env).length > 0) {
		return 'email_or_domain_allowlist';
	}
	return 'any_authenticated_user';
}

export function getChatgptMcpAuthMode(env: AppEnv): 'disabled' | 'oidc_deny_all' | 'oidc_email_allowlist' {
	if (env.CHATGPT_MCP_AUTH_MODE?.trim().toLowerCase() !== 'oidc') {
		return 'disabled';
	}
	if (getChatgptMcpAllowedEmails(env).length === 0) {
		return 'oidc_deny_all';
	}
	return 'oidc_email_allowlist';
}

export function getChatgptMcpIssuer(env: AppEnv): string | null {
	const value = env.CHATGPT_MCP_ISSUER?.trim();
	return value ? value : null;
}

export function getChatgptMcpAudiences(env: AppEnv): string[] {
	return parseCsv(env.CHATGPT_MCP_AUDIENCE);
}

export function getChatgptMcpJwksUrl(env: AppEnv): string | null {
	const value = env.CHATGPT_MCP_JWKS_URL?.trim();
	return value ? value : null;
}

export function getChatgptMcpJwksJson(env: AppEnv): string | null {
	const value = env.CHATGPT_MCP_JWKS_JSON?.trim();
	return value ? value : null;
}

export function getChatgptMcpAllowedEmails(env: AppEnv): string[] {
	return parseCsvLower(env.CHATGPT_MCP_ALLOWED_EMAILS);
}

export function getGuiOidcClientId(env: AppEnv): string | null {
	const value = env.GUI_OIDC_CLIENT_ID?.trim();
	return value ? value : null;
}

export function getGuiOidcAudience(env: AppEnv): string | null {
	const explicit = env.GUI_OIDC_AUDIENCE?.trim();
	if (explicit) {
		return explicit;
	}
	const audiences = getChatgptMcpAudiences(env);
	const preferred = audiences.find((audience) => !audience.endsWith('/userinfo'));
	return preferred ?? audiences[0] ?? null;
}

export function getGuiOidcScope(env: AppEnv): string {
	const value = env.GUI_OIDC_SCOPE?.trim();
	return value || 'openid profile email';
}

export function getAllowedWorkflows(env: AppEnv): string[] {
	return parseCsv(env.GITHUB_ALLOWED_WORKFLOWS);
}

export function normalizeWorkflowList(workflows: unknown, context: string): string[] {
	if (!Array.isArray(workflows)) {
		throw new Error(`${context} must be an array of workflow ids`);
	}
	return workflows.map((item) => {
		if (typeof item !== 'string' || !item.trim()) {
			throw new Error(${context} entries must be non-empty strings`);
		}
		return item.trim();
	});
}

export function getFileAllowedWorkflowsByRepo(): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [repo, config] of Object.entries(workflowAllowlistConfig)) {
		if (Array.isArray(config)) {
			result[repo] = normalizeWorkflowList(config, `workflowAllowlistConfig.${repo}`);
		}
	}
	return result;
}

export function getEnvAllowedWorkflowsByRepo(env: Partial<AppEnv>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	const raw = env.GITHUB_ALLOWED_WORKFLOWS_BY_REPO?.trim();
	if (!raw) {
		return result;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!hasRecord(parsed)) {
			throw new Error('GITHUB_ALLOWED_WORKFLOWS_BY_REPO must be a JSON object mapping repo to workflow ids');
		}
		for (const [repo, workflows] of Object.entries(parsed)) {
			if (!Array.isArray(workflows)) {
				throw new Error(`GITHUB_ALLOWED_WORKFLOWS_BY_REPO.${repo} must be an array of workflow ids`);
			}
			result[repo] = workflows.map((w) => String(w).trim()).filter(Boolean);
		}
		return result;
	} catch (error) {
		if (error instanceof Error && error.message.includes('must be an array')) {
			throw error;
		}
		throw new Error(
			`failed to parse GITHUB_ALLOWED_WORKFLOWS_BY_REPO: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function getAllowedWorkflowsByRepo(env: Partial<AppEnv>): Record<string, string[]> {
	const fileBased = getFileAllowedWorkflowsByRepo();
	const envBased = getEnvAllowedWorkflowsByRepo(env);
	const repos = new Set([...Object.keys(fileBased), ...Object.keys(envBased)]);
	const result: Record<string, string[]> = {};
	for (const repo of repos) {
		result[repo] = Array.from(new Set([...(fileBased[repo] ?? []), ...(envBased[repo] ?? [])]));
	}
	return result;
}

export function getAllowedWorkflowsForRepo(env: Partial<AppEnv>, repoKey: string): string[] {
	const merged = getAllowedWorkflowsByRepo(env);
	if (merged[repoKey]) {
		return merged[repoKey];
	}
	return getAllowedWorkflows(env as AppEnv);
}

export function inspectAllowedWorkflowsForRepo(env: Partial<AppEnv>, repoKey: string) {
	const fileBased = getFileAllowedWorkflowsByRepo();
	const envBased = getEnvAllowedWorkflowsByRepo(env);
	const fileEntries = fileBased[repoKey] ?? [];
	const envEntries = envBased[repoKey] ?? [];
	return {
		repo_key: repoKey,
		file_based_entries: fileEntries,
		env_based_entries: envEntries,
		env_global_fallback: getAllowedWorkflows(env as AppEnv),
		effective_allowlist: getAllowedWorkflowsForRepo(env, repoKey),
		repo_specific_match_found: Boolean(fileBased[repoKey] || envBased[repoKey]),
	};
}

export function getSelfDeployEnv(env: Partial<AppEnv>): 'live' | 'mirror' | 'unknown' {
	const explicit = env.SELF_DEPLOY_ENV?.trim().toLowerCase();
	if (explicit === 'live') return 'live';
	if (explicit === 'mirror') return 'mirror';

	const currentUrl = env.SELF_CURRENT_URL?.trim().replace(/\/$/, '');
	const liveUrl = env.SELF_LIVE_URL?.trim().replace(/\/$/, '');
	const mirrorUrl = env.SELF_MIRROR_URL?.trim().replace(/\/$/, '');

	if (currentUrl && liveUrl && currentUrl === liveUrl) return 'live';
	if (currentUrl && mirrorUrl && currentUrl === mirrorUrl) return 'mirror';

	return 'unknown';
}

export function ensureLiveSelfHostControl(env: Partial<AppEnv>, action: string): void {
	if (getSelfDeployEnv(env) !== 'live') {
		throw new Error(`${action} requires the live self-host worker`);
	}
}

export function normalizeWorkflowInputs(inputs: Record<string, unknown>): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(inputs)) {
		if (key === 'instructions_json' && hasRecord(value)) {
			const json = JSON.stringify(value);
			try {
				JSON.parse(json);
				result.instructions_b64 = btoa(json);
			} catch {
				throw new Error('instructions_json must be valid JSON');
			}
			continue;
		}
		if (key === 'instructions_b64' && typeof value === 'string') {
			try {
				JSON.parse(atob(value));
			} catch {
				throw new Error('instructions_b64 must decode to valid JSON');
			}
		}
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			result[key] = value;
		}
	}
	return result;
}

export function mirrorConfigured(env: Partial<AppEnv>): boolean {
	const liveUrl = env.SELF_LIVE_URL?.trim();
	const mirrorUrl = env.SELF_MIRROR_URL?.trim();
	return Boolean(liveUrl && mirrorUrl && liveUrl !== mirrorUrl);
}

export function getDefaultAutoImproveMaxCycles(env: Partial<AppEnv>): number {
	const value = Number(env.DEFAULT_AUTO_IMPROVE_MAX_CYCLES?.trim());
	return Number.isFinite(value) && value >= 0 ? value : 10;
}

export function getBranchPrefix(env: AppEnv): string {
	const value = env.AGENT_BRANCH_PREFIX?.trim();
	return value || 'agent/';
}

export function getDefaultBaseBranch(env: AppEnv): string {
	const value = env.DEFAULT_BASE_BRANCH?.trim();
	return value || 'main';
}

export function getSelfRepoKey(env: AppEnv): string {
	const value = env.SELF_REPO_KEY?.trim();
	if (!value) {
		throw new Error('SELF_REPO_KEY environment variable is required');
	}
	return value;
}

export function getSelfLiveUrl(env: AppEnv): string | null {
	const value = env.SELF_LIVE_URL?.trim();
	return value ? value : null;
}

export function getSelfMirrorUrl(env: AppEnv): string | null {
	const value = env.SELF_MIRROR_URL?.trim();
	return value ? value : null;
}

export function getSelfCurrentUrl(env: AppEnv): string | null {
	const value = env.SELF_CURRENT_URL?.trim();
	return value ? value : null;
}

export function getSelfReleaseCommitSha(env: AppEnv): string | null {
	const value = env.SELF_RELEASE_COMMIT_SHA?.trim();
	return value ? value : null;
}

export function selfRequiresMirrorForLive(env: AppEnv): boolean {
	return env.SELF_REQUIRE_MIRROR_FOR_LIVE?.trim().toLowerCase() === 'true';
}

export function getSelfDeployWorkflow(env: AppEnv): string {
	const value = env.SELF_DEPLOY_WORKFLOW?.trim();
	return value || 'cloudflare-deploy.yml';
}

export function getSelfDefaultDeployTarget(env: AppEnv): 'mirror' | 'live' {
	return env.SELF_DEFAULT_DEPLOY_TARGET?.trim() === 'live' ? 'live' : 'mirror';
}
