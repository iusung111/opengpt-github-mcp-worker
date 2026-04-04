import type {
	MissionProgressSnapshot,
	MissionRecord,
	JobRecord,
	JobProgressSnapshot,
	AuditRecord,
} from '../contracts';
import {
	jobMissionIndexPrefix,
	JobIndexPointer,
} from '../queue-index';
import {
	buildMissionProgressSnapshot as buildQueueMissionProgressSnapshot,
} from './missions/projections';
import {
	ensureMissionIndexes as ensureQueueMissionIndexes,
	getMission as getStoredMission,
	listMissions as listStoredMissions,
	missionRecordNeedsNormalization,
	normalizeStoredMissionRecord,
	persistMission as persistStoredMission,
} from './missions/store';
import { createMissionStoreContext } from './durable-object-storage';

export function createMissionActions(
	ctx: DurableObjectState,
	helpers: any,
	actions: {
		getJob: (jobId: string) => Promise<JobRecord | null>;
		reconcileJob: (job: JobRecord) => Promise<JobRecord>;
		ensureJobIndexes: () => Promise<void>;
		listAuditRecords: (eventType?: string, jobId?: string, limit?: number) => Promise<AuditRecord[]>;
		buildJobProgressSnapshot: (job: JobRecord, audits: AuditRecord[]) => JobProgressSnapshot;
	},
	getReconcileMission: () => (mission: MissionRecord) => Promise<MissionRecord>
) {
	const persistMission = async (mission: MissionRecord, previous?: MissionRecord | null): Promise<void> => {
		await persistStoredMission(createMissionStoreContext(ctx, helpers, getReconcileMission()), mission, previous);
	};

	const getMission = async (missionId: string): Promise<MissionRecord | null> => {
		const mission = await getStoredMission(createMissionStoreContext(ctx, helpers, getReconcileMission()), missionId);
		if (!mission) return null;
		if (!missionRecordNeedsNormalization(mission)) return mission;
		const normalized = normalizeStoredMissionRecord(mission);
		await persistMission(normalized, mission);
		return normalized;
	};

	const ensureMissionIndexes = async (): Promise<void> => {
		await ensureQueueMissionIndexes(createMissionStoreContext(ctx, helpers, getReconcileMission()));
	};

	const listMissionJobs = async (missionId: string): Promise<JobRecord[]> => {
		await actions.ensureJobIndexes();
		const pointers = await ctx.storage.list<JobIndexPointer>({ prefix: jobMissionIndexPrefix(missionId) });
		const jobs: JobRecord[] = [];
		for (const pointer of pointers.values()) {
			const job = await actions.getJob(pointer.job_id);
			if (job) {
				jobs.push(await actions.reconcileJob(job));
			}
		}
		return jobs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
	};

	const listMissions = async (options: { status?: MissionRecord['status']; repo?: string } = {}): Promise<MissionRecord[]> => {
		await ensureMissionIndexes();
		return listStoredMissions(createMissionStoreContext(ctx, helpers, getReconcileMission()), options);
	};

	const buildMissionProgressSnapshot = async (mission: MissionRecord): Promise<MissionProgressSnapshot> => {
		const childProgressByJobId = new Map<string, JobProgressSnapshot>();
		let latestNotification = null;
		for (const lane of mission.lanes) {
			if (!lane.current_job_id) continue;
			const job = await actions.getJob(lane.current_job_id);
			if (!job) continue;
			const audits = await actions.listAuditRecords(undefined, job.job_id, 10);
			const progress = actions.buildJobProgressSnapshot(job, audits);
			childProgressByJobId.set(job.job_id, progress);
			if (progress.latest_notification && (!latestNotification || progress.latest_notification.created_at > latestNotification.created_at)) {
				latestNotification = progress.latest_notification;
			}
		}
		return buildQueueMissionProgressSnapshot(mission, childProgressByJobId, latestNotification);
	};

	return {
		persistMission,
		getMission,
		ensureMissionIndexes,
		listMissionJobs,
		listMissions,
		buildMissionProgressSnapshot,
	};
}
