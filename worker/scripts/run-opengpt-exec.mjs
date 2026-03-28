import { executeWorkflowRequest } from './opengpt-workflow-runner.mjs';

executeWorkflowRequest({
	artifactDirName: 'opengpt-exec-artifact',
	defaultKind: 'generic',
	defaultArtifactPaths: [],
});
