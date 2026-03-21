import { describe, expect, it } from 'vitest';
import {
	enforceAuditRetention,
	enforceDeliveryRetention,
	listAuditRecords,
	tryRegisterDelivery,
	writeAudit,
} from '../src/queue-audit';
import { deliveryStorageKey } from '../src/queue-helpers';
import { AuditRecord, DeliveryRecord } from '../src/types';

function createContext(
	audits: Array<[string, AuditRecord]> = [],
	deliveries: Array<[string, DeliveryRecord]> = [],
	limits: { audit?: number; delivery?: number } = {},
) {
	const auditMap = new Map(audits);
	const deliveryMap = new Map(deliveries);

	return {
		auditMap,
		deliveryMap,
		context: {
			getAuditRetentionCount: () => limits.audit ?? 2,
			getDeliveryRetentionCount: () => limits.delivery ?? 2,
			listAuditStorage: async () => auditMap,
			listDeliveryStorage: async () => deliveryMap,
			putStorage: async (key: string, value: unknown) => {
				if (key.startsWith('audit:')) {
					auditMap.set(key, value as AuditRecord);
					return;
				}
				deliveryMap.set(key, value as DeliveryRecord);
			},
			deleteStorage: async (keys: string[] | string) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					auditMap.delete(key);
					deliveryMap.delete(key);
				}
			},
		},
	};
}

describe('queue-audit helpers', () => {
	it('enforces audit retention by deleting the oldest entries', async () => {
		const { context, auditMap } = createContext([
			['audit:1', { event_type: 'a', payload: {}, created_at: '2026-03-21T00:00:00.000Z' }],
			['audit:2', { event_type: 'b', payload: {}, created_at: '2026-03-21T00:00:01.000Z' }],
			['audit:3', { event_type: 'c', payload: {}, created_at: '2026-03-21T00:00:02.000Z' }],
		]);

		await enforceAuditRetention(context);

		expect(Array.from(auditMap.keys())).toEqual(['audit:2', 'audit:3']);
	});

	it('filters audit records by job id and returns newest first', async () => {
		const { context } = createContext([
			['audit:1', { event_type: 'job_create', payload: { job_id: 'job-1' }, created_at: '2026-03-21T00:00:00.000Z' }],
			['audit:2', { event_type: 'job_update', payload: { job_id: 'job-2' }, created_at: '2026-03-21T00:00:01.000Z' }],
			['audit:3', { event_type: 'job_update', payload: { job_id: 'job-1' }, created_at: '2026-03-21T00:00:02.000Z' }],
		]);

		const records = await listAuditRecords(context, undefined, 'job-1', 10);

		expect(records.map((record) => record.created_at)).toEqual([
			'2026-03-21T00:00:02.000Z',
			'2026-03-21T00:00:00.000Z',
		]);
	});

	it('deduplicates existing delivery ids and registers new ones', async () => {
		const { context, deliveryMap } = createContext(
			[],
			[
				['delivery:old-1', { delivery_id: 'old-1', created_at: '2026-03-21T00:00:00.000Z' }],
				['delivery:old-2', { delivery_id: 'old-2', created_at: '2026-03-21T00:00:01.000Z' }],
			],
			{ delivery: 3 },
		);

		expect(await tryRegisterDelivery(context, 'old-2')).toBe(false);
		expect(await tryRegisterDelivery(context, 'new-1')).toBe(true);
		expect(deliveryMap.has(deliveryStorageKey('old-1'))).toBe(true);
		expect(deliveryMap.has(deliveryStorageKey('old-2'))).toBe(true);
		expect(deliveryMap.has(deliveryStorageKey('new-1'))).toBe(true);
	});

	it('enforces delivery retention by deleting the oldest deliveries', async () => {
		const { context, deliveryMap } = createContext(
			[],
			[
				['delivery:old-1', { delivery_id: 'old-1', created_at: '2026-03-21T00:00:00.000Z' }],
				['delivery:old-2', { delivery_id: 'old-2', created_at: '2026-03-21T00:00:01.000Z' }],
				['delivery:new-1', { delivery_id: 'new-1', created_at: '2026-03-21T00:00:02.000Z' }],
			],
			{ delivery: 2 },
		);

		await enforceDeliveryRetention(context);

		expect(deliveryMap.has(deliveryStorageKey('old-1'))).toBe(false);
		expect(deliveryMap.has(deliveryStorageKey('old-2'))).toBe(true);
		expect(deliveryMap.has(deliveryStorageKey('new-1'))).toBe(true);
	});

	it('writes an audit record through the context store', async () => {
		const { context, auditMap } = createContext();

		await writeAudit(context, 'job_create', { job_id: 'job-1' });

		expect(auditMap.size).toBe(1);
		expect(Array.from(auditMap.values())[0]).toMatchObject({
			event_type: 'job_create',
			payload: { job_id: 'job-1' },
		});
	});
});
