import type { AppEnv, JobRecord } from '../contracts';
import {
	getReviewStaleAfterMs,
	getWorkingStaleAfterMs,
	githubPost,
	nowIso,
	repoAllowed,
} from '../utils';
import { githubAuthConfigured } from '../github';
import { mergeWorkerManifest } from '../job-manifest';
import {
	handleWorkingTimeoutReconcile,
	reconcileGitHubRunState,
	shouldHandleReviewTimeout,
} from '../queue-reconcile';
import { pushJobNote } from '../queue-state';

export function createReconcileActions(
	env: AppEnv,
	actions: {
		persistJob: (job: JobRecord, previous?: JobRecord | null) => Promise<void>;
		writeAudit: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
		autoRedispatchJob: (job: JobRecord, reason: string) => Promise<boolean>;
		buildJobAudit: (job: JobRecord, extra?: Record<string, unknown>) => Record<string, unknown>;
	}
) {
	const markJobStale = async (job: JobRecord, reason: string, note: string): Promise<boolean> => {
		if (job.stale_reason === reason) {
			return false;
		}
		const previous = structuredClone(job);
		job.stale_reason = reason;
		pushJobNote(job, note);
		job.worker_manifest = mergeWorkerManifest(job.worker_manifest, {
			control: {
				last_interrupt: {
					kind: 'stale_reconcile',
					source: 'queue',
					message: note,
					recorded_at: nowIso(),
				},
			},
		});
		job.updated_at = nowIso();
		await actions.persistJob(job, previous);
		await actions.writeAudit('job_reconcile_stale', actions.buildJobAudit(job, { reason }));
		await actions.writeAudit('job_interrupt_recorded', {
			job_id: job.job_id,
			repo: job.repo,
			interrupt_kind: 'stale_reconcile',
			source_layer: 'system',
			attention_status: 'interrupted',
			message: note,
		});
		return true;
	};

	const cancelWorkflowRun = async (
		job: JobRecord,
	): Promise<{ attempted: boolean; cancelled: boolean; error: string | null }> => {
		if (!job.workflow_run_id || !githubAuthConfigured(env) || !repoAllowed(env, job.repo)) {
			return { attempted: false, cancelled: false, error: null };
		}
		const [owner, repo] = job.repo.split('/');
		if (!owner || !repo) {
			return { attempted: false, cancelled: false, error: 'invalid repo key' };
		}
		try {
			await githubPost(env, `/repos/${owner}/${repo}/actions/runs/${job.workflow_run_id}/cancel`);
			return { attempted: true, cancelled: true, error: null };
		} catch (error) {
			return {
				attempted: true,
				cancelled: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	const reconcileJob = async (job: JobRecord): Promise<JobRecord> => {
		job.last_reconciled_at = nowIso();
		if (
			await handleWorkingTimeoutReconcile(
				{
					env,
					persistJob: actions.persistJob,
					markJobStale,
					autoRedispatchJob: actions.autoRedispatchJob,
				},
				job,
				getWorkingStaleAfterMs(env),
			)
		) {
			return job;
		}
		if (!githubAuthConfigured(env) || !repoAllowed(env, job.repo)) {
			if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(env))) {
				await markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		await reconcileGitHubRunState(
			{
				env,
				persistJob: actions.persistJob,
				markJobStale,
				autoRedispatchJob: actions.autoRedispatchJob,
			},
			job,
		);
		if (!job.workflow_run_id) {
			if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(env))) {
				await markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
			}
			return job;
		}
		if (shouldHandleReviewTimeout(job, getReviewStaleAfterMs(env))) {
			await markJobStale(job, 'review_timeout', 'review pending beyond configured threshold');
		}
		return job;
	};

	return {
		markJobStale,
		cancelWorkflowRun,
		reconcileJob,
	};
}
