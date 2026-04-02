import type { AppEnv } from '../contracts';

export function getQueueAuthToken(env: AppEnv): string | null {
	const queueToken = env.QUEUE_API_TOKEN?.trim();
	if (queueToken) return queueToken;
	const webhookSecret = env.WEBHOOK_SECRET?.trim();
	return webhookSecret ? webhookSecret : null;
}

export function queueRequestAuthorized(request: Request, env: AppEnv): boolean {
	const expected = getQueueAuthToken(env);
	if (!expected) return false;
	const headerToken = request.headers.get('x-queue-token')?.trim();
	if (headerToken && headerToken === expected) return true;
	const authorization = request.headers.get('authorization') ?? '';
	if (authorization.startsWith('Bearer ')) {
		return authorization.slice('Bearer '.length).trim() === expected;
	}
	return false;
}
