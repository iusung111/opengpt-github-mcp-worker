import { githubAuthConfigured } from './github';
import { JobRecord } from './types';
import { buildDispatchFingerprint, githubPost, nowIso } from './utils';
import { getDispatchRequest, pushJobNote, transitionJob } from './queue-state';

export interface QueueDispatchContext {
	env: Parameters<typeof githubAuthConfigured>[0];
}

export async function autoRedispatchJob(
	context: QueueDispatchContext,
	job: JobRecord,
	reason: string,
): Promise<boolean> {
	const dispatchRequest = getDispatchRequest(job);
	if (!dispatchRequest || !githubAuthConfigured(context.env)) {
		return false;
	}
	const fingerprint = await buildDispatchFingerprint(
		dispatchRequest.owner,
		dispatchRequest.repo,
		dispatchRequest.workflow_id,
		dispatchRequest.ref,
		dispatchRequest.inputs,
		job.auto_improve_cycle,
	);
	await githubPost(
		context.env,
		`/repos/${dispatchRequest.owner}/${dispatchRequest.repo}/actions/workflows/${dispatchRequest.workflow_id}/dispatches`,
		{
			ref: dispatchRequest.ref,
			inputs: dispatchRequest.inputs,
		},
	);
	transitionJob(job, 'working', 'system');
	job.workflow_run_id = undefined;
	job.last_error = undefined;
	job.stale_reason = undefined;
	pushJobNote(job, `auto redispatch triggered: ${reason}`);
	job.worker_manifest = {
		...job.worker_manifest,
		dispatch_request: {
			...dispatchRequest,
			fingerprint,
			dispatched_at: nowIso(),
		},
		last_workflow_run: {
			status: 'queued',
			conclusion: null,
			html_url: null,
		},
	};
	return true;
}
