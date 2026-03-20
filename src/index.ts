import { createMcpHandler } from 'agents/mcp';
import { githubAuthConfigured, githubGet } from './github';
import { buildMcpServer } from './mcp-tools';
import { JobQueueDurableObject, verifyWebhookSignature } from './queue';
import { AppEnv, JobRecord, JobStatus, NextActor } from './types';
import {
	activateRepoWorkspace,
	getAllowedRepos,
	getAllowedWorkflows,
	getAuditRetentionCount,
	getBranchPrefix,
	getDeliveryRetentionCount,
	getDefaultAutoImproveMaxCycles,
	getDefaultBaseBranch,
	getDispatchDedupeWindowMs,
	getReviewStaleAfterMs,
	getWorkingStaleAfterMs,
	queueFetch,
	queueJson,
	fail,
	ok,
	repoAllowed,
	jsonResponse
} from './utils';

export { JobQueueDurableObject };

function getQueueAuthToken(env: AppEnv): string | null {
	const token = env.WEBHOOK_SECRET?.trim();
	return token ? token : null;
}

function queueRequestAuthorized(request: Request, env: AppEnv): boolean {
	const expected = getQueueAuthToken(env);
	if (!expected) {
		return false;
	}
	const headerToken = request.headers.get('x-queue-token')?.trim();
	if (headerToken && headerToken === expected) {
		return true;
	}
	const authorization = request.headers.get('authorization') ?? '';
	if (authorization.startsWith('Bearer ')) {
		return authorization.slice('Bearer '.length).trim() === expected;
	}
	return false;
}

async function handleWebhook(request: Request, env: AppEnv): Promise<Response> {
	if (env.REQUIRE_WEBHOOK_SECRET === 'true' && !env.WEBHOOK_SECRET) {
		return jsonResponse(fail('server_error', 'webhook secret configuration missing'), 500);
	}
	const signature = request.headers.get('x-hub-signature-256');
	const deliveryId = request.headers.get('x-github-delivery') ?? undefined;
	const bodyText = await request.text();
	if (env.REQUIRE_WEBHOOK_SECRET === 'true') {
		const verified = await verifyWebhookSignature(env.WEBHOOK_SECRET ?? '', bodyText, signature);
		if (!verified) {
			return jsonResponse(fail('unauthorized', 'invalid webhook signature'), 401);
		}
	}
	let payload: any;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return jsonResponse(fail('bad_request', 'invalid json'), 400);
	}
	const repo = payload.repository?.full_name;
	if (!repo || !repoAllowed(env, repo)) {
		return jsonResponse(fail('repo_not_allowlisted', 'repository not allowlisted'), 403);
	}
	try {
		const result = await queueJson(env, { action: 'github_event', payload, delivery_id: deliveryId });
		if (result.ok && result.data) {
			return jsonResponse({ ok: true, ...result.data });
		}
		return jsonResponse(result);
	} catch (error) {
		return jsonResponse(fail('webhook_processing_failed', error), 500);
	}
}

async function handleQueueApi(request: Request, env: AppEnv): Promise<Response> {
	if (!queueRequestAuthorized(request, env)) {
		return jsonResponse(fail('unauthorized', 'invalid queue token'), 401);
	}
	const url = new URL(request.url);
	if (request.method === 'POST' && url.pathname === '/queue/job') {
		const job = (await request.json()) as Partial<JobRecord> & { job_id: string };
		return queueFetch(env, { action: 'job_upsert', job });
	}
	if (request.method === 'GET' && url.pathname.startsWith('/queue/job/')) {
		const jobId = url.pathname.split('/').pop();
		return queueFetch(env, { action: 'job_get', job_id: jobId });
	}
	if (request.method === 'GET' && url.pathname === '/queue/jobs') {
		const status = url.searchParams.get('status') as JobStatus | null;
		const nextActor = url.searchParams.get('next_actor') as NextActor | null;
		return queueFetch(env, {
			action: 'jobs_list',
			status: status ?? undefined,
			next_actor: nextActor ?? undefined,
		});
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const appEnv = env as AppEnv;
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/healthz') {
			return jsonResponse({
				ok: true,
				service: 'opengpt-github-mcp-worker',
				runtime: 'cloudflare-workers',
				durable_object_binding: true,
				auth_configured: githubAuthConfigured(appEnv),
				allowed_repos: getAllowedRepos(appEnv),
				allowed_workflows: getAllowedWorkflows(appEnv),
				branch_prefix: getBranchPrefix(appEnv),
				require_webhook_secret: String(appEnv.REQUIRE_WEBHOOK_SECRET) === 'true',
				working_stale_after_ms: getWorkingStaleAfterMs(appEnv),
				review_stale_after_ms: getReviewStaleAfterMs(appEnv),
				dispatch_dedupe_window_ms: getDispatchDedupeWindowMs(appEnv),
				audit_retention_count: getAuditRetentionCount(appEnv),
				delivery_retention_count: getDeliveryRetentionCount(appEnv),
			});
		}

		if (request.method === 'GET' && url.pathname === '/github/app-installation') {
			if (!githubAuthConfigured(appEnv)) {
				return jsonResponse(fail('github_auth_not_configured', 'github auth not configured'), 400);
			}
			try {
				const repo = getAllowedRepos(appEnv)[0] ?? 'iusung111/OpenGPT';
				const [owner, name] = repo.split('/');
				const data = await githubGet(appEnv, `/repos/${owner}/${name}`);
				return jsonResponse(ok({ repository: data as Record<string, unknown> }));
			} catch (error) {
				return jsonResponse(fail('github_app_installation_failed', error), 502);
			}
		}

		if (url.pathname === '/webhooks/github') {
			return handleWebhook(request, appEnv);
		}

		if (url.pathname.startsWith('/queue/')) {
			return handleQueueApi(request, appEnv);
		}

		if (url.pathname === '/mcp') {
			const handler = createMcpHandler(buildMcpServer(appEnv) as never, {
				route: '/mcp',
				enableJsonResponse: true,
			});
			return handler(request, appEnv, ctx);
		}

		return jsonResponse(fail('not_found', 'not found'), 404);
	},
} satisfies ExportedHandler<AppEnv>;
