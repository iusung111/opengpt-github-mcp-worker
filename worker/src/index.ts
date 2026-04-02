import { JobQueueDurableObject } from './queue';
import { UploadSessionDurableObject } from './upload-session';
import { AppEnv } from './contracts';
import { routeRequest } from './runtime/router';

export { JobQueueDurableObject, UploadSessionDurableObject };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return routeRequest(request, env as AppEnv, ctx);
	},
} satisfies ExportedHandler<AppEnv>;

