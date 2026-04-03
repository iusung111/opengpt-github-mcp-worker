import type { MissionRecord } from '../../contracts';

export interface MissionIndexPointer {
	mission_id: string;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

export function missionIndexReadyKey(): string {
	return 'meta:indexes:missions:v1';
}

export function missionAllIndexKey(missionId: string): string {
	return `idx:mission:${encodeSegment(missionId)}`;
}

export function missionAllIndexPrefix(): string {
	return 'idx:mission:';
}

export function missionRepoIndexKey(repo: string, missionId: string): string {
	return `idx:mission-repo:${encodeSegment(repo)}:${encodeSegment(missionId)}`;
}

export function missionRepoIndexPrefix(repo?: string): string {
	return repo ? `idx:mission-repo:${encodeSegment(repo)}:` : 'idx:mission-repo:';
}

export function missionStatusIndexKey(status: MissionRecord['status'], missionId: string): string {
	return `idx:mission-status:${status}:${encodeSegment(missionId)}`;
}

export function missionStatusIndexPrefix(status?: MissionRecord['status']): string {
	return status ? `idx:mission-status:${status}:` : 'idx:mission-status:';
}

export function buildMissionIndexEntries(mission: MissionRecord): Array<[string, MissionIndexPointer]> {
	const pointer = { mission_id: mission.mission_id };
	return [
		[missionAllIndexKey(mission.mission_id), pointer],
		[missionRepoIndexKey(mission.repo, mission.mission_id), pointer],
		[missionStatusIndexKey(mission.status, mission.mission_id), pointer],
	];
}
