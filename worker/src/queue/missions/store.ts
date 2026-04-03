import type { MissionRecord } from '../../contracts';
import { canonicalizeRepoKey } from '../../repo-aliases';
import { missionStorageKey } from '../../queue-helpers';
import {
	buildMissionIndexEntries,
	type MissionIndexPointer,
	missionAllIndexPrefix,
	missionIndexReadyKey,
	missionRepoIndexPrefix,
	missionStatusIndexPrefix,
} from './indexes';

export interface MissionStoreContext {
	getStorage<T>(key: string): Promise<T | null>;
	putStorage(key: string, value: unknown): Promise<void>;
	deleteStorage(keys: string[] | string): Promise<void>;
	listMissions(): Promise<MissionRecord[]>;
	reconcileMission(mission: MissionRecord): Promise<MissionRecord>;
	listMissionIndexPointers(prefix: string): Promise<MissionIndexPointer[]>;
}

export function normalizeStoredMissionRecord(mission: MissionRecord): MissionRecord {
	const canonicalRepo = canonicalizeRepoKey(mission.repo);
	return canonicalRepo === mission.repo ? mission : { ...mission, repo: canonicalRepo };
}

export function missionRecordNeedsNormalization(mission: MissionRecord): boolean {
	return canonicalizeRepoKey(mission.repo) !== mission.repo;
}

export async function getMission(context: MissionStoreContext, missionId: string): Promise<MissionRecord | null> {
	return (await context.getStorage<MissionRecord>(missionStorageKey(missionId))) ?? null;
}

export async function ensureMissionIndexes(context: MissionStoreContext): Promise<void> {
	const ready = await context.getStorage<boolean>(missionIndexReadyKey());
	if (ready) {
		return;
	}
	for (const mission of await context.listMissions()) {
		for (const [key, value] of buildMissionIndexEntries(mission)) {
			await context.putStorage(key, value);
		}
	}
	await context.putStorage(missionIndexReadyKey(), true);
}

export async function persistMission(
	context: MissionStoreContext,
	mission: MissionRecord,
	previous?: MissionRecord | null,
): Promise<void> {
	const previousEntries = new Map(previous ? buildMissionIndexEntries(previous) : []);
	const nextEntries = new Map(buildMissionIndexEntries(mission));
	const keysToDelete = Array.from(previousEntries.keys()).filter((key) => !nextEntries.has(key));
	if (keysToDelete.length > 0) {
		await context.deleteStorage(keysToDelete);
	}
	await context.putStorage(missionStorageKey(mission.mission_id), mission);
	for (const [key, value] of nextEntries) {
		await context.putStorage(key, value);
	}
}

export async function listMissions(
	context: MissionStoreContext,
	options: { status?: MissionRecord['status']; repo?: string } = {},
): Promise<MissionRecord[]> {
	await ensureMissionIndexes(context);
	const prefix = options.status
		? missionStatusIndexPrefix(options.status)
		: options.repo
			? missionRepoIndexPrefix(options.repo)
			: missionAllIndexPrefix();
	const missions: MissionRecord[] = [];
	for (const pointer of await context.listMissionIndexPointers(prefix)) {
		const mission = await getMission(context, pointer.mission_id);
		if (!mission) {
			continue;
		}
		const reconciled = await context.reconcileMission(mission);
		if (options.status && reconciled.status !== options.status) {
			continue;
		}
		if (options.repo && reconciled.repo !== options.repo) {
			continue;
		}
		missions.push(reconciled);
	}
	return missions.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}
