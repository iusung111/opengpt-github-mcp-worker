import { AuditRecord, DeliveryRecord } from './types';
import { auditStorageKey, deliveryStorageKey } from './queue-helpers';
import { nowIso } from './utils';

export interface QueueAuditContext {
	getAuditRetentionCount(): number;
	getDeliveryRetentionCount(): number;
	listAuditStorage(): Promise<Map<string, AuditRecord>>;
	listDeliveryStorage(): Promise<Map<string, DeliveryRecord>>;
	putStorage(key: string, value: unknown): Promise<void>;
	deleteStorage(keys: string[] | string): Promise<void>;
}

export async function enforceAuditRetention(context: QueueAuditContext): Promise<void> {
	const limit = context.getAuditRetentionCount();
	const records = await context.listAuditStorage();
	const overflow = records.size - limit;
	if (overflow <= 0) {
		return;
	}
	const keysToDelete: string[] = [];
	let index = 0;
	for (const key of records.keys()) {
		if (index >= overflow) {
			break;
		}
		keysToDelete.push(key);
		index += 1;
	}
	if (keysToDelete.length > 0) {
		await context.deleteStorage(keysToDelete);
	}
}

export async function enforceDeliveryRetention(context: QueueAuditContext): Promise<void> {
	const limit = context.getDeliveryRetentionCount();
	const records = await context.listDeliveryStorage();
	const deliveries = Array.from(records.entries())
		.map(([key, record]) => ({ key, created_at: record.created_at }))
		.sort((left, right) => left.created_at.localeCompare(right.created_at));
	const overflow = deliveries.length - limit;
	if (overflow <= 0) {
		return;
	}
	await context.deleteStorage(deliveries.slice(0, overflow).map((item) => item.key));
}

export async function writeAudit(
	context: QueueAuditContext,
	eventType: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await context.putStorage(auditStorageKey(`${Date.now()}-${crypto.randomUUID()}`), {
		event_type: eventType,
		payload,
		created_at: nowIso(),
	});
	await enforceAuditRetention(context);
}

export async function listAuditRecords(
	context: QueueAuditContext,
	eventType?: string,
	jobId?: string,
	limit = 20,
): Promise<AuditRecord[]> {
	const safeLimit = Math.max(1, Math.min(limit, 100));
	const filtered: AuditRecord[] = [];
	const records = await context.listAuditStorage();

	for (const [, record] of records) {
		if (eventType && record.event_type !== eventType) {
			continue;
		}
		if (jobId && record.payload.job_id !== jobId) {
			continue;
		}
		filtered.push(record);
	}

	return filtered.slice(Math.max(0, filtered.length - safeLimit)).reverse();
}

export async function tryRegisterDelivery(
	context: QueueAuditContext,
	deliveryId?: string,
): Promise<boolean> {
	if (!deliveryId) {
		return true;
	}
	const key = deliveryStorageKey(deliveryId);
	const records = await context.listDeliveryStorage();
	if (records.has(key)) {
		return false;
	}
	await context.putStorage(key, { delivery_id: deliveryId, created_at: nowIso() });
	await enforceDeliveryRetention(context);
	return true;
}
