import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSessionScreenLoadLifetime } from './session-screen-load-lifetime';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

describe('session screen load lifetime', () => {
	it.each(['Overview', 'Exercise'])('%s cannot overwrite newer caches after unmount', async () => {
		const oldLifetime = createSessionScreenLoadLifetime();
		const oldGeneration = oldLifetime.beginLoad();
		const oldResponse = deferred<{ session: string; picker: string }>();
		const caches = { session: 'initial', picker: 'initial' };
		const finishOldLoad = (async () => {
			const response = await oldResponse.promise;

			if (oldLifetime.isCurrent(oldGeneration)) {
				caches.session = response.session;
				caches.picker = response.picker;
			}
		})();

		oldLifetime.dispose();
		const newLifetime = createSessionScreenLoadLifetime();
		const newGeneration = newLifetime.beginLoad();

		if (newLifetime.isCurrent(newGeneration)) {
			caches.session = 'new-session';
			caches.picker = 'new-picker';
		}

		oldResponse.resolve({ session: 'old-session', picker: 'old-picker' });
		await finishOldLoad;

		expect(caches).toEqual({ session: 'new-session', picker: 'new-picker' });
	});

	it('suppresses an abandoned-session redirect resolved after Exercise unmounts', async () => {
		const lifetime = createSessionScreenLoadLifetime();
		const generation = lifetime.beginLoad();
		const response = deferred<'abandoned'>();
		const navigate = vi.fn();
		const finishLoad = (async () => {
			const status = await response.promise;

			if (lifetime.isCurrent(generation) && status === 'abandoned') {
				navigate();
			}
		})();

		lifetime.dispose();
		response.resolve('abandoned');
		await finishLoad;

		expect(navigate).not.toHaveBeenCalled();
	});

	it('fences both screen implementations before cache writes and Exercise navigation', () => {
		const overviewSource = readFileSync(
			resolve(import.meta.dirname, 'SessionOverviewScreen.svelte'),
			'utf8'
		);
		const exerciseSource = readFileSync(
			resolve(import.meta.dirname, 'SessionExerciseScreen.svelte'),
			'utf8'
		);

		for (const source of [overviewSource, exerciseSource]) {
			expect(source).toContain('createSessionScreenLoadLifetime()');
			expect(source).toContain('loadLifetime.dispose();');
			expect(source).toContain('loadLifetime.isCurrent(generation)');

			const loadBlock = source.slice(
				source.indexOf('\n\tasync function loadData'),
				source.indexOf('\n\tasync function runMutation')
			);
			const sessionCacheWriteIndex = loadBlock.indexOf('writeSessionDataCache(sessionId');
			const sessionGuardIndex = loadBlock.lastIndexOf(
				'loadLifetime.isCurrent(generation)',
				sessionCacheWriteIndex
			);
			const pickerLoadIndex = loadBlock.indexOf('async function loadExercisePickerData');
			const pickerCacheWriteIndex = loadBlock.indexOf('writeExercisePickerCache', pickerLoadIndex);
			const pickerGuardIndex = loadBlock.lastIndexOf(
				'loadLifetime.isCurrent(generation)',
				pickerCacheWriteIndex
			);

			expect(sessionCacheWriteIndex).toBeGreaterThan(-1);
			expect(sessionGuardIndex).toBeGreaterThan(-1);
			expect(sessionGuardIndex).toBeLessThan(sessionCacheWriteIndex);
			expect(pickerLoadIndex).toBeGreaterThan(-1);
			expect(pickerCacheWriteIndex).toBeGreaterThan(pickerLoadIndex);
			expect(pickerGuardIndex).toBeGreaterThan(pickerLoadIndex);
			expect(pickerGuardIndex).toBeLessThan(pickerCacheWriteIndex);
		}

		const exerciseLoad = exerciseSource.slice(
			exerciseSource.indexOf('\n\tasync function loadData'),
			exerciseSource.indexOf('\n\tasync function runMutation')
		);
		const redirectIndex = exerciseLoad.indexOf("nextOverview?.summary.status === 'abandoned'");

		expect(redirectIndex).toBeGreaterThan(-1);
		expect(
			exerciseLoad.lastIndexOf('loadLifetime.isCurrent(generation)', redirectIndex)
		).toBeGreaterThan(-1);
	});
});
