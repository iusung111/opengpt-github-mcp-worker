export const PHASE2_FILE_WRITE_READY = true;

export type Phase2FileWriteMode = 'create' | 'upsert' | 'update';

export interface Phase2FileWriteOptions {
	mode: Phase2FileWriteMode;
}
