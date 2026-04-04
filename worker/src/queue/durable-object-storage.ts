import type { DurableObjectState } from 'cloudflare:workers';
import type { AppEnv, JobRecord, MissionRecord, AuditRecord, DeliveryRecord } from '../contracts';
import { getAuditRetentionCount, getDeliveryRetentionCount } from '../utils';
import { incrementReadCounter } from '../read-observability';
import type { MissionIndexPointer } from './missions/indexes';

export function createStorageHelpers(ctx: DurableObjectState) {
	const getStorageValue = async <T>(key: string): Promise<T | null> => (await ctx.storage.get<T>(key)) ?? null;
	const putStorageValue = async (key: string, value: unknown): Promise<void> => { await ctx.storage.put(key, value); };
	const deleteStorageValue = async (keys: string[] | string): Promise<void> => {
		if (Array.isArray(keys)) {
			await ctx.storage.delete(keys);
			return;
		}
		await ctx.storage.delete(keys);
	};

	const listStoredJobs = async (): Promise<JobRecord[]> => {
		incrementReadCounter('queue_storage_list_call');
		return Array.from((await ctx.storage.list<JobRecord>({ prefix: 'job:' })).values());
	};

	const listStoredMissions = async (): Promise<MissionRecord[]> => {
		incrementReadCounter('queue_storage_list_call');
		return Array.from((await ctx.storage.list<MissionRecord>({ prefix: 'mission:' })).values());
	};

	const listStoredAudits = async (): Promise<Map<string, AuditRecord>> => {
		incrementReadCounter('queue_storage_list_call');
		return ctx.storage.list<AuditRecord>({ prefix: 'audit:' });
	};

	const listStoredDeliveries = async (): Promise<Map<string, DeliveryRecord>> => {
		incrementReadCounter('queue_storage_list_call');
		return ctx.storage.list<DeliveryRecord>({ prefix: 'delivery:' });
	};

	return {
		getStorageValue,
		putStorageValue,
		deleteStorageValue,
		listStoredJobs,
		listStoredMissions,
		listStoredAudits,
		listStoredDeliveries,
	};
}

export function createQueueAuditContext(
	env: AppEnv,
	helpers: ReturnType<typeof createStorageHelpers>
) {
	return {
		getAuditRetentionCount: () => getAuditRetentionCount(env),
		getDeliveryRetentionCount: () => getDeliveryRetentionCount(env),
		listAuditStorage: helpers.listStoredAudits,
		listDeliveryStorage: helpers.listStoredDeliveries,
		putStorage: helpers.putStorageValue,
		deleteStorage: helpers.deleteStorageValue,
	};
}

export function createQueueStoreContext(
	helpers: ReturnType<typeof createStorageHelpers>,
	reconcileJob: (job: JobRecord) => Promise<JobRecord>
) {
	return {
		getStorage: helpers.getStorageValue,
		putStorage: helpers.putStorageValue,
		deleteStorage: helpers.deleteStorageValue,
		listJobs: helpers.listStoredJobs,
		reconcileJob,
	};
}

export function createMissionStoreContext(
	ctx: DurableObjectState,
	helpers: ReturnType<typeof createStorageHelpers>,
	reconcileMission: (mission: MissionRecord) => Promise<MissionRecord>
) {
	return {
		getStorage: helpers.getStorageValue,
		putStorage: helpers.putStorageValue,
		deleteStorage: helpers.deleteStorageValue,
		listMissions: helpers.listStoredMissions,
		reconcileMission,
		listMissionIndexPointers: async (prefix: string) =>
			Array.from((await ctx.storage.list<MissionIndexPointer>({ prefix })).values()),
	};
}
