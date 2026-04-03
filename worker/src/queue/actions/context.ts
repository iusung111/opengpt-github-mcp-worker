import type {
	AuditRecord,
	JobProgressSnapshot,
	JobRecord,
	JobStatus,
	MissionProgressSnapshot,
	MissionRecord,
	NextActor,
	ToolResultEnvelope,
	WorkspaceRecord,
} from '../../contracts';

export type QueueResponse = Response;

export interface QueueRequestContext {
	upsertJob(job: Partial<JobRecord> & { job_id: string }): Promise<void>;
	getJob(jobId: string): Promise<JobRecord | null>;
	listMissionJobs(missionId: string): Promise<JobRecord[]>;
	reconcileJob(job: JobRecord): Promise<JobRecord>;
	persistJob(job: JobRecord, previous?: JobRecord | null): Promise<void>;
	getMission(missionId: string): Promise<MissionRecord | null>;
	reconcileMission(mission: MissionRecord): Promise<MissionRecord>;
	persistMission(mission: MissionRecord, previous?: MissionRecord | null): Promise<void>;
	listMissions(options?: { status?: MissionRecord['status']; repo?: string }): Promise<MissionRecord[]>;
	writeAudit(eventType: string, payload: Record<string, unknown>): Promise<void>;
	buildJobAudit(job: JobRecord, extra?: Record<string, unknown>): Record<string, unknown>;
	buildJobProgressSnapshot(job: JobRecord, recentAudits: AuditRecord[]): JobProgressSnapshot;
	buildMissionProgressSnapshot(mission: MissionRecord): Promise<MissionProgressSnapshot>;
	listAuditRecords(eventType?: string, jobId?: string, limit?: number): Promise<AuditRecord[]>;
	listJobs(status?: JobStatus, nextActor?: NextActor): Promise<JobRecord[]>;
	getWorkspace(repoKey: string): Promise<WorkspaceRecord | null>;
	listWorkspaces(): Promise<Array<WorkspaceRecord & { is_active?: boolean }>>;
	getActiveWorkspaceRepoKey(): Promise<string | null>;
	findSimilarWorkspaces(query?: string, repoKey?: string): Promise<ToolResultEnvelope>;
	tryRegisterDelivery(deliveryId?: string): Promise<boolean>;
	applyGithubEvent(
		payload: Record<string, unknown>,
		deliveryId: string,
	): Promise<{
		matched: boolean;
		job_id?: string;
		status?: string;
		next_actor?: string;
		pr_number?: number;
		work_branch?: string;
		delivery_id?: string;
		duplicate?: boolean;
	}>;
	putWorkspace(workspace: WorkspaceRecord): Promise<void>;
	setActiveWorkspace(repoKey: string): Promise<void>;
	autoRedispatchJob(job: JobRecord, reason: string): Promise<boolean>;
	cancelWorkflowRun(job: JobRecord): Promise<{ attempted: boolean; cancelled: boolean; error: string | null }>;
}

export function jobNotFound(jobId: string): QueueResponse {
	return new Response(JSON.stringify({ ok: false, code: 'job_not_found', error: `job ${jobId} not found` }), {
		status: 404,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

export function workspaceNotFound(repoKey: string): QueueResponse {
	return new Response(JSON.stringify({ ok: false, code: 'workspace_not_found', error: `workspace ${repoKey} not found` }), {
		status: 404,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}
