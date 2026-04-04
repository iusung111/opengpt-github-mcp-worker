import type {
	AppEnv,
	WorkspaceRecord,
	AuditRecord,
	ToolResultEnvelope,
	JobRecord,
} from '../contracts';
import { ok } from '../utils';
import {
	listAuditRecords as listQueueAuditRecords,
	tryRegisterDelivery as tryRegisterQueueDelivery,
	writeAudit as writeQueueAudit,
} from '../queue-audit';
import {
	activeWorkspaceStorageKey,
	workspaceStorageKey,
} from '../queue-helpers';
import {
	getActiveWorkspaceRepoKey as getActiveWorkspaceKey,
	getWorkspace as getStoredWorkspace,
} from '../queue-store';
import {
	findSimilarWorkspaceMatches,
	normalizeWorkspaceRecord,
	sortWorkspaces,
	workspaceRecordNeedsNormalization,
} from '../queue-workspaces';
import { createQueueAuditContext, createQueueStoreContext } from './durable-object-storage';

export function createWorkspaceActions(
	ctx: DurableObjectState,
	env: AppEnv,
	helpers: any,
	getReconcileJob: () => (job: JobRecord) => Promise<JobRecord>
) {
	const writeAudit = async (eventType: string, payload: Record<string, unknown>): Promise<void> => {
		await writeQueueAudit(createQueueAuditContext(env, helpers), eventType, payload);
	};

	const listAuditRecords = async (eventType?: string, jobId?: string, limit = 20): Promise<AuditRecord[]> => {
		return listQueueAuditRecords(createQueueAuditContext(env, helpers), eventType, jobId, limit);
	};

	const getWorkspace = async (repoKey: string): Promise<WorkspaceRecord | null> => {
		return getStoredWorkspace(createQueueStoreContext(helpers, getReconcileJob()), repoKey);
	};

	const listWorkspaces = async (): Promise<Array<WorkspaceRecord & { is_active?: boolean }>> => {
		const workspaces: WorkspaceRecord[] = [];
		const records = await ctx.storage.list<WorkspaceRecord>({ prefix: 'workspace:' });
		for (const [, value] of records) {
			if (!value || typeof value !== 'object' || !('repo_key' in value) || !('workspace_path' in value)) continue;
			const normalized = normalizeWorkspaceRecord(value);
			workspaces.push(normalized);
			if (workspaceRecordNeedsNormalization(value)) {
				await helpers.putStorageValue(workspaceStorageKey(normalized.repo_key), normalized);
			}
		}
		const activeRepoKey = await getActiveWorkspaceKey(createQueueStoreContext(helpers, getReconcileJob()));
		return sortWorkspaces(workspaces, activeRepoKey);
	};

	const findSimilarWorkspaces = async (query?: string, repoKey?: string): Promise<ToolResultEnvelope> => {
		const workspaces = await listWorkspaces();
		const matches = findSimilarWorkspaceMatches(workspaces, query, repoKey);
		return ok({ matches });
	}

	return {
		writeAudit,
		listAuditRecords,
		getWorkspace,
		listWorkspaces,
		findSimilarWorkspaces,
		getActiveWorkspaceRepoKey: () => getActiveWorkspaceKey(createQueueStoreContext(helpers, getReconcileJob())),
		tryRegisterDelivery: (deliveryId?: string) => tryRegisterQueueDelivery(createQueueAuditContext(env, helpers), deliveryId),
		putWorkspace: (workspace: WorkspaceRecord) => helpers.putStorageValue(workspaceStorageKey(workspace.repo_key), workspace),
		setActiveWorkspace: (repoKey: string) => helpers.putStorageValue(activeWorkspaceStorageKey(), repoKey),
	};
}
