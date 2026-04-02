import type { AppEnv } from '../../contracts';
import { verifyWebhookSignature } from '../../queue-helpers';
import { fail, jsonResponse, queueJson, repoAllowed } from '../../utils';

export async function handleWebhook(request: Request, env: AppEnv): Promise<Response> {
	if (env.REQUIRE_WEBHOOK_SECRET === 'true' && !env.WEBHOOK_SECRET) {
		return jsonResponse(fail('server_error', 'webhook secret configuration missing'), 500);
	}
	const signature = request.headers.get('x-hub-signature-256');
	const deliveryId = request.headers.get('x-github-delivery') ?? undefined;
	const bodyText = await request.text();
	if (env.REQUIRE_WEBHOOK_SECRET === 'true') {
		const verified = await verifyWebhookSignature(env.WEBHOOK_SECRET ?? '', bodyText, signature);
		if (!verified) {
			return jsonResponse(fail('unauthorized', 'invalid webhook signature'), 401);
		}
	}
	let payload: any;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return jsonResponse(fail('bad_request', 'invalid json'), 400);
	}
	const repo = payload.repository?.full_name;
	if (!repo || !repoAllowed(env, repo)) {
		return jsonResponse(fail('repo_not_allowlisted', 'repository not allowlisted'), 403);
	}
	try {
		const result = await queueJson(env, { action: 'github_event', payload, delivery_id: deliveryId });
		if (result.ok && result.data) {
			return jsonResponse({ ok: true, ...result.data });
		}
		return jsonResponse(result);
	} catch (error) {
		return jsonResponse(fail('webhook_processing_failed', error), 500);
	}
}
