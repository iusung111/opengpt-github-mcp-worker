import type { AppEnv, JobBrowserRemoteControlState, QueueEnvelope } from '../contracts';
import type { QueueRequestContext } from '../queue/actions/context';
import { jsonResponse, fail } from '../utils';
import { handleQueueAction } from '../queue-requests';
import { handleBrowserControlRequest } from './browser-control-router';

export interface JobQueueRequestContext extends QueueRequestContext {
	env: AppEnv;
	getBrowserRemoteControlState(): Promise<JobBrowserRemoteControlState | null>;
	persistBrowserRemoteControlState(value: unknown): Promise<JobBrowserRemoteControlState | null>;
}

export async function handleJobQueueDurableObjectRequest(
	request: Request,
	url: URL,
	context: JobQueueRequestContext,
): Promise<Response> {
	if (url.pathname === '/browser-control' || url.pathname.startsWith('/browser-control/')) {
		try {
			return await handleBrowserControlRequest(request, url, {
				getBrowserRemoteControlState: context.getBrowserRemoteControlState,
				persistBrowserRemoteControlState: context.persistBrowserRemoteControlState,
				getJob: context.getJob,
				writeAudit: context.writeAudit,
			});
		} catch (error) {
			return jsonResponse(fail('browser_control_error', error instanceof Error ? error.message : String(error)), 500);
		}
	}

	if (request.method === 'POST' && url.pathname === '/queue') {
		try {
			const payload = (await request.json()) as QueueEnvelope;
			const response = await handleQueueAction(
				{
					upsertJob: context.upsertJob,
					getJob: context.getJob,
					reconcileJob: context.reconcileJob,
					persistJob: context.persistJob,
					writeAudit: context.writeAudit,
					buildJobAudit: context.buildJobAudit,
					buildJobProgressSnapshot: context.buildJobProgressSnapshot,
					listAuditRecords: context.listAuditRecords,
					listJobs: context.listJobs,
					getWorkspace: context.getWorkspace,
					listWorkspaces: context.listWorkspaces,
					getActiveWorkspaceRepoKey: context.getActiveWorkspaceRepoKey,
					findSimilarWorkspaces: context.findSimilarWorkspaces,
					tryRegisterDelivery: context.tryRegisterDelivery,
					autoRedispatchJob: context.autoRedispatchJob,
					cancelWorkflowRun: context.cancelWorkflowRun,
					applyGithubEvent: context.applyGithubEvent,
					putWorkspace: context.putWorkspace,
					setActiveWorkspace: context.setActiveWorkspace,
				},
				payload,
				request,
			);
			if (response) return response;
			return jsonResponse(fail('invalid_action', 'unknown action or missing parameters'), 400);
		} catch (error) {
			return jsonResponse(fail('queue_error', error instanceof Error ? error.message : String(error)), 500);
		}
	}

	return jsonResponse(fail('not_found', 'not found'), 404);
}
