import { DurableObject } from 'cloudflare:workers';
import { AppEnv } from './contracts';
import { handleJobQueueDurableObjectRequest } from './queue/durable-object-routes';
import { createStorageHelpers } from './queue/durable-object-storage';
import { createReconcileActions } from './queue/durable-object-reconcile';
import { createQueueActions } from './queue/durable-object-actions';
import { createBrowserActions } from './queue/durable-object-browser';

/**
 * JobQueueDurableObject provides a durable state machine for managing jobs,
 * missions, and workspaces. It delegates most of its logic to specialized
 * helper functions and action creators to maintain a clean, scalable structure.
 */
export class JobQueueDurableObject extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		
		const storageHelpers = createStorageHelpers(this.ctx);
		const browserActions = createBrowserActions(storageHelpers);

		// Use a late-binding approach for circular dependencies between reconcile and queue actions
		let queueActions: any;

		const reconcileActions = createReconcileActions(this.env, {
			persistJob: async (job, prev) => await queueActions.persistJob(job, prev),
			writeAudit: async (type, payload) => await queueActions.writeAudit(type, payload),
			autoRedispatchJob: async (job, reason) => await queueActions.autoRedispatchJob(job, reason),
			buildJobAudit: (job, extra) => queueActions.buildJobAudit(job, extra),
		});

		queueActions = createQueueActions(this.ctx, this.env, storageHelpers, reconcileActions);

		return handleJobQueueDurableObjectRequest(request, url, {
			env: this.env,
			...queueActions,
			reconcileJob: reconcileActions.reconcileJob,
			autoRedispatchJob: queueActions.autoRedispatchJob,
			cancelWorkflowRun: reconcileActions.cancelWorkflowRun,
			getBrowserRemoteControlState: browserActions.getBrowserRemoteControlState,
			persistBrowserRemoteControlState: browserActions.persistBrowserRemoteControlState,
		});
	}
}
