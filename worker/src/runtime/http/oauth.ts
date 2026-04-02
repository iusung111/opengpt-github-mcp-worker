import type { AppEnv } from '../../contracts';
import { githubAuthConfigured, githubGet } from '../../github';
import {
	fail,
	getAllowedRepos,
	getChatgptMcpAudiences,
	getChatgptMcpDocumentationUrl,
	jsonResponse,
	ok,
} from '../../utils';
import { PROJECT_REPO_KEY } from '../../repo-aliases';

export function handleOAuthProtectedResourceMetadata(request: Request, env: AppEnv): Response {
	const url = new URL(request.url);
	const origin = `${url.protocol}//${url.host}`;
	const issuer = env.CHATGPT_MCP_ISSUER?.trim() || null;
	const audiences = getChatgptMcpAudiences(env);
	return jsonResponse({
		resource: `${origin}/chatgpt/mcp`,
		authorization_servers: issuer ? [issuer.replace(/\/$/, '')] : [],
		scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
		bearer_methods_supported: ['header'],
		resource_documentation: getChatgptMcpDocumentationUrl(env),
		audiences,
	});
}

export async function handleGitHubAppInstallation(env: AppEnv): Promise<Response> {
	if (!githubAuthConfigured(env)) {
		return jsonResponse(fail('github_auth_not_configured', 'github auth not configured'), 400);
	}
	try {
		const repo = getAllowedRepos(env)[0] ?? PROJECT_REPO_KEY;
		const [owner, name] = repo.split('/');
		const data = await githubGet(env, `/repos/${owner}/${name}`);
		return jsonResponse(ok({ repository: data as Record<string, unknown> }));
	} catch (error) {
		return jsonResponse(fail('github_app_installation_failed', error), 502);
	}
}
