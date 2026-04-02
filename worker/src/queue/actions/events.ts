import type { QueueEnvelope } from '../../contracts';
import { jsonResponse, ok } from '../../utils';
import type { QueueRequestContext, QueueResponse } from './context';

export async function handleGitHubEvent(context: QueueRequestContext, payload: QueueEnvelope, request: Request): Promise<QueueResponse> {
	const deliveryId = (payload.delivery_id || request.headers.get('x-github-delivery') || `delivery-${Date.now()}`) as string;
	if (!(await context.tryRegisterDelivery(deliveryId))) {
		return jsonResponse(ok({ outcome: { matched: false, duplicate: true, delivery_id: deliveryId } }));
	}
	const outcome = await context.applyGithubEvent(payload.payload as Record<string, unknown>, deliveryId);
	await context.writeAudit('github_event_processed', { delivery_id: deliveryId, outcome });
	return jsonResponse(ok({ outcome }));
}
