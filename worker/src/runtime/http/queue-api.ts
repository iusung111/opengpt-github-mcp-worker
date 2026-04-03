import type { AppEnv, JobRecord, JobStatus, NextActor } from '../../contracts';
import { queueRequestAuthorized } from '../../auth';
import { fail, jsonResponse, queueFetch } from '../../utils';

export async function handleQueueApi(request: Request, env: AppEnv): Promise<Response> {
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
	if (request.method === 'POST' && url.pathname === '/queue/mission') {
		const mission = (await request.json()) as Record<string, unknown> & { mission_id: string };
		return queueFetch(env, { action: 'mission_create', mission });
	}
	if (request.method === 'GET' && url.pathname.startsWith('/queue/mission/')) {
		const missionId = url.pathname.split('/').pop();
		return queueFetch(env, { action: 'mission_progress', mission_id: missionId });
	}
	if (request.method === 'GET' && url.pathname === '/queue/missions') {
		return queueFetch(env, {
			action: 'mission_list',
			mission_status: (url.searchParams.get('status') as any) ?? undefined,
			repo_key: url.searchParams.get('repo') ?? undefined,
		});
	}
	return jsonResponse(fail('not_found', 'not found'), 404);
}
