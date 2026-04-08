import { getGitHubCredentialSource, githubAuthConfigured, githubCredentialSplitConfigured, usingMirrorGitHubCredentials } from '../../github';
import { getReadObservabilitySnapshot } from '../../read-observability';
import type { AppEnv } from '../../contracts';
import {
	getAllowedRepos,
	getAllowedWorkflows,
	getAllowedWorkflowsByRepo,
	getAuditRetentionCount,
	getBranchPrefix,
	getChatgptMcpAllowedEmails,
	getChatgptMcpAuthMode,
	getDeliveryRetentionCount,
	getDispatchDedupeWindowMs,
	getEnvAllowedWorkflowsByRepo,
	getFileAllowedWorkflowsByRepo,
	getMcpAccessMode,
	getMcpAllowedEmailDomains,
	getMcpAllowedEmails,
	getMcpRequireAccessAuth,
	getReviewStaleAfterMs,
	getSelfCurrentUrl,
	getSelfDeployEnv,
	getSelfLiveUrl,
	getSelfMirrorUrl,
	getSelfReleaseCommitSha,
	getWorkingStaleAfterMs,
	isSelfImproveSafeModeEnabled,
	isStrictDocImplSyncEnabled,
	isStrictFingerprintBlockEnabled,
	isStrictMirrorVerifyEnabled,
	jsonResponse,
} from '../../utils';

export function handleHealth(env: AppEnv): Response {
	const deployEnvironment = getSelfDeployEnv(env);
	const githubCredentialSource = getGitHubCredentialSource(env);
	const githubCredentialSplitReady = githubCredentialSplitConfigured(env);
	const usingMirrorCredentials = usingMirrorGitHubCredentials(env);
	const warnings: string[] = [];
	if (deployEnvironment === 'mirror' && !githubCredentialSplitReady) {
		warnings.push('mirror is using fallback GitHub App credentials; mirror/live GitHub permission split is not configured');
	}
	if (deployEnvironment === 'mirror' && githubCredentialSource !== 'mirror') {
		warnings.push(`mirror is not using mirror-specific GitHub credentials; current source is ${githubCredentialSource}`);
	}
	return jsonResponse({
		ok: true,
		service: 'opengpt-github-mcp-worker',
		runtime: 'cloudflare-workers',
		deploy_environment: deployEnvironment,
		release_commit_sha: getSelfReleaseCommitSha(env),
		self_urls: {
			current: getSelfCurrentUrl(env),
			live: getSelfLiveUrl(env),
			mirror: getSelfMirrorUrl(env),
		},
		durable_object_binding: true,
		auth_configured: githubAuthConfigured(env),
		github_credential_source: githubCredentialSource,
		github_credential_split_configured: githubCredentialSplitReady,
		using_mirror_github_credentials: usingMirrorCredentials,
		strict_mirror_verify: isStrictMirrorVerifyEnabled(env),
		strict_doc_impl_sync: isStrictDocImplSyncEnabled(env),
		strict_fingerprint_block: isStrictFingerprintBlockEnabled(env),
		self_improve_safe_mode: isSelfImproveSafeModeEnabled(env),
		warnings,
		allowed_repos: getAllowedRepos(env),
		allowed_workflows: getAllowedWorkflows(env),
		allowed_workflows_file_by_repo: getFileAllowedWorkflowsByRepo(),
		allowed_workflows_env_by_repo: getEnvAllowedWorkflowsByRepo(env),
		allowed_workflows_by_repo: getAllowedWorkflowsByRepo(env),
		branch_prefix: getBranchPrefix(env),
		require_webhook_secret: String(env.REQUIRE_WEBHOOK_SECRET) === 'true',
		working_stale_after_ms: getWorkingStaleAfterMs(env),
		review_stale_after_ms: getReviewStaleAfterMs(env),
		dispatch_dedupe_window_ms: getDispatchDedupeWindowMs(env),
		audit_retention_count: getAuditRetentionCount(env),
		delivery_retention_count: getDeliveryRetentionCount(env),
		mcp_access_auth_required: getMcpRequireAccessAuth(env),
		mcp_access_mode: getMcpAccessMode(env),
		mcp_allowed_emails_count: getMcpAllowedEmails(env).length,
		mcp_allowed_email_domains_count: getMcpAllowedEmailDomains(env).length,
		direct_mcp_auth_required: getMcpRequireAccessAuth(env),
		direct_mcp_auth_mode: getMcpAccessMode(env),
		chatgpt_mcp_auth_mode: getChatgptMcpAuthMode(env),
		chatgpt_allowed_emails_count: getChatgptMcpAllowedEmails(env).length,
		read_observability: getReadObservabilitySnapshot(),
	});
}
