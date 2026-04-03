import { describe, expect, it } from 'vitest';

import { buildAttentionItems, isHiddenConsoleJob, visibleLegacyJobs, yoloAllEnabled } from '../../public/gui/run-console/state/attention-center.mjs';

describe('run console attention center', () => {
	it('hides smoke jobs and gui approval test jobs from legacy lists', () => {
		const store = {
			jobOrder: ['smoke-demo', 'gui-approval', 'keep-me'],
			jobsById: {
				'smoke-demo': {
					jobId: 'smoke-demo',
					title: 'Smoke demo',
					targetPaths: ['notes/smoke-demo.txt'],
					missionId: '',
				},
				'gui-approval': {
					jobId: 'gui-approval',
					title: 'gui_approval_test for iusung111/Project_OpenGPT',
					targetPaths: [],
					missionId: '',
				},
				'keep-me': {
					jobId: 'keep-me',
					title: 'Real operator job',
					targetPaths: [],
					missionId: '',
				},
			},
		};

		expect(isHiddenConsoleJob(store.jobsById['smoke-demo'])).toBe(true);
		expect(isHiddenConsoleJob(store.jobsById['gui-approval'])).toBe(true);
		expect(visibleLegacyJobs(store).map((job) => job.jobId)).toEqual(['keep-me']);
	});

	it('builds attention items from actionable missions and jobs only', () => {
		const store = {
			missionOrder: ['mission-1', 'mission-2'],
			missionsById: {
				'mission-1': {
					missionId: 'mission-1',
					title: 'Blocked mission',
					status: 'blocked',
					counts: { blocked: 1, failed: 0 },
					updatedAt: '2026-04-04T00:00:00.000Z',
					latestNotification: null,
				},
				'mission-2': {
					missionId: 'mission-2',
					title: 'Completed mission',
					status: 'completed',
					counts: { blocked: 0, failed: 0 },
					updatedAt: '2026-04-04T00:00:00.000Z',
					latestNotification: null,
				},
			},
			jobOrder: ['job-1', 'job-2', 'job-3'],
			jobsById: {
				'job-1': {
					jobId: 'job-1',
					title: 'Pending approval',
					status: 'pending_approval',
					approval: { pending: true, reason: 'Need approval' },
					lastEvent: 'Need approval',
					updatedAt: '2026-04-04T00:01:00.000Z',
					targetPaths: [],
					missionId: '',
				},
				'job-2': {
					jobId: 'job-2',
					title: 'Completed',
					status: 'completed',
					approval: null,
					lastEvent: 'Done',
					updatedAt: '2026-04-04T00:02:00.000Z',
					targetPaths: [],
					missionId: '',
				},
				'job-3': {
					jobId: 'job-3',
					title: 'gui_approval_test for iusung111/Project_OpenGPT',
					status: 'pending_approval',
					approval: { pending: true, reason: 'Noise' },
					lastEvent: 'Noise',
					updatedAt: '2026-04-04T00:03:00.000Z',
					targetPaths: [],
					missionId: '',
				},
			},
		};

		expect(buildAttentionItems(store).map((item) => item.id)).toEqual(['job:job-1', 'mission:mission-1']);
	});

	it('treats yolo all as enabled only when every mission is enabled', () => {
		expect(
			yoloAllEnabled({
				missionOrder: ['a', 'b'],
				missionsById: { a: { yoloMode: true }, b: { yoloMode: true } },
			}),
		).toBe(true);
		expect(
			yoloAllEnabled({
				missionOrder: ['a', 'b'],
				missionsById: { a: { yoloMode: true }, b: { yoloMode: false } },
			}),
		).toBe(false);
	});
});
