import { executeWorkflowRequest } from './opengpt-workflow-runner.mjs';

executeWorkflowRequest({
	artifactDirName: 'opengpt-package-artifact',
	defaultKind: 'desktop_build',
	defaultArtifactPaths: [],
});
