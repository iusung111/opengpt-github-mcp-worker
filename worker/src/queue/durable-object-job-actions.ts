import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
	AppEnv,
	JobRecord,
	JobStatus,
	NextActor,
	AuditRecord,
	JobProgressSnapshot,
} from '../contracts';
import {
	jobRecordNeedsNormalization,
	listJobs as listQueueJobs,
	normalizeStoredJobRecord,
	upsertJob as upsertQueueJob,
} from '../queue-jobs';
import {
	buildJobAudit as buildQueueJobAudit,
	buildJobProgressSnapshot as buildQueueJobProgressSnapshot,
} from '../queue-projections';
import {
	ensureJobIndexes as ensureQueueJobIndexes,
	getJob as getStoredJob,
	persistJob as persistStoredJob,
} from '../queue-store';
import {
	JobIndexPointer,
} from '../queue-index';
import { createQueueStoreContext } from './durable-object-storage';

export function createJobActions(
	ctx: DurableObjectState,
	env: AppEnv,
	helpers: any,
	getReconcileJob: () => (job: JobRecord) => Promise<JobRecord>
) {
	const persistJob = async (job: JobRecord, previous?: JobRecord | null): Promise<void> => {
		await persistStoredJob(createQueueStoreContext(helpers, getReconcileJob()), job, previous);
	};

	const getJob = async (jobId: string): Promise<JobRecord | null> => {
		const job = await getStoredJob(createQueueStoreContext(helpers, getReconcileJob()), jobId);
		if (!job) return null;
		if (!jobRecordNeedsNormalization(job)) return job;
		const normalized = normalizeStoredJobRecord(job);
		await persistJob(normalized, job);
		return normalized;
	};

	const ensureJobIndexes = async (): Promise<void> => {
		await ensureQueueJobIndexes(createQueueStoreContext(helpers, getReconcileJob()));
	};

	const upsertJob = async (job: Partial<JobRecord> & { job_id: string }): Promise<void> => {
		await upsertQueueJob({ getJob, persistJob }, job);
	};

	const listJobs = async (status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]> => {
		return listQueueJobs(
			{
				ensureJobIndexes,
				getJob,
				reconcileJob: getReconcileJob(),
				listJobIndexPointers: async (prefix) =>
					Array.from((await ctx.storage.list<JobIndexPointer>({ prefix })).values()),
			},
			status,
			nextActor,
		);
	};

	const buildJobAudit = (job: JobRecord, extra: Record<string, unknown> = {}): Record<string, unknown> => {
		return buildQueueJobAudit(job, extra);
	};

	const buildJobProgressSnapshot = (job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot => {
		return buildQueueJobProgressSnapshot(job, recentAudits);
	};

	return {
		persistJob,
		getJob,
		ensureJobIndexes,
		upsertJob,
		listJobs,
		buildJobAudit,
		buildJobProgressSnapshot,
	};
}
