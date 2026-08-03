// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExerciseDetail } from '$lib/db';
import ExercisesScreen from './ExercisesScreen.svelte';

const dbMocks = vi.hoisted(() => ({
	ensureDbOpen: vi.fn(async () => undefined),
	getExerciseDetail: vi.fn<(exerciseId: string) => Promise<ExerciseDetail | null>>(),
	listExerciseItems: vi.fn(async () => [])
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => undefined)
}));
vi.mock('$app/paths', () => ({
	resolve: (route: string, parameters: Record<string, string> = {}) =>
		Object.entries(parameters).reduce(
			(path, [key, value]) => path.replace(`[...${key}]`, value),
			route.replace('/(app)', '')
		)
}));
vi.mock('$lib/db', () => dbMocks);

function buildExerciseDetail(): ExerciseDetail {
	const timestamp = '2026-08-03T12:00:00.000Z';

	return {
		exercise: {
			id: 'exercise-1',
			name: 'Cable Curl',
			normalizedName: 'cable curl',
			unilateral: false,
			source: 'custom',
			archived: false,
			createdAt: timestamp,
			updatedAt: timestamp
		},
		history: [],
		resetEvents: []
	};
}

afterEach(() => {
	document.body.replaceChildren();
	vi.clearAllMocks();
});

describe('ExercisesScreen', () => {
	it('loads an exercise detail once without subscribing to the loaded detail', async () => {
		dbMocks.getExerciseDetail.mockResolvedValue(buildExerciseDetail());
		const target = document.createElement('div');
		document.body.append(target);
		const instance = mount(ExercisesScreen, {
			target,
			props: { exerciseId: 'exercise-1' }
		});

		try {
			await vi.waitFor(() => expect(target.textContent).toContain('Cable Curl'));
			await tick();

			expect(dbMocks.getExerciseDetail).toHaveBeenCalledOnce();
			expect(dbMocks.getExerciseDetail).toHaveBeenCalledWith('exercise-1');
		} finally {
			await unmount(instance);
		}
	});
});
