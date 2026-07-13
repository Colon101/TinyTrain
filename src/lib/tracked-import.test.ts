import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
	currentUser: { isLoggedIn: true },
	ensureDbOpen: vi.fn(),
	syncNow: vi.fn(),
	exercisesToArray: vi.fn(),
	exercisesBulkAdd: vi.fn(),
	workoutsToArray: vi.fn(),
	workoutsBulkAdd: vi.fn(),
	workoutExercisesToArray: vi.fn(),
	workoutExercisesBulkPut: vi.fn(),
	workoutExercisesBulkDelete: vi.fn(),
	workoutSessionsToArray: vi.fn(),
	workoutSessionsBulkGet: vi.fn(),
	workoutSessionsBulkAdd: vi.fn(),
	sessionExercisesBulkAdd: vi.fn(),
	sessionSetsBulkAdd: vi.fn(),
	transaction: vi.fn()
}));

vi.mock('./db', async () => {
	const { normalizeName, toDayKey } =
		await vi.importActual<typeof import('./db/shared')>('./db/shared');

	return {
		db: {
			cloud: { currentUser: { value: dbMock.currentUser } },
			exercises: {
				toArray: dbMock.exercisesToArray,
				bulkAdd: dbMock.exercisesBulkAdd
			},
			workouts: {
				toArray: dbMock.workoutsToArray,
				bulkAdd: dbMock.workoutsBulkAdd
			},
			workoutExercises: {
				where: () => ({
					anyOf: () => ({
						toArray: dbMock.workoutExercisesToArray
					})
				}),
				bulkPut: dbMock.workoutExercisesBulkPut,
				bulkDelete: dbMock.workoutExercisesBulkDelete
			},
			workoutSessions: {
				where: () => ({
					anyOf: () => ({
						toArray: dbMock.workoutSessionsToArray
					})
				}),
				bulkGet: dbMock.workoutSessionsBulkGet,
				bulkAdd: dbMock.workoutSessionsBulkAdd
			},
			sessionExercises: { bulkAdd: dbMock.sessionExercisesBulkAdd },
			sessionSets: { bulkAdd: dbMock.sessionSetsBulkAdd },
			transaction: dbMock.transaction
		},
		ensureDbOpen: dbMock.ensureDbOpen,
		normalizeName,
		syncNow: dbMock.syncNow,
		toDayKey
	};
});

import { importTrackedArchive, previewTrackedArchive } from './tracked-import';

const validCsv = {
	'exercises.csv': 'id,name\nbench,Barbell Bench Press',
	'sessions.csv': 'id,sessionDate\ns1,2026-07-01',
	'sets.csv':
		'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir\nset1,s1,bench,Barbell Bench Press,8,80,2'
};

function trackedZip(
	files: Record<string, string>,
	name = 'tracked.zip',
	declaredOriginalSize?: number
) {
	const zipped = zipSync(
		Object.fromEntries(Object.entries(files).map(([path, contents]) => [path, strToU8(contents)]))
	);

	if (declaredOriginalSize !== undefined) {
		const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
		let offset = 0;

		while (offset + 30 <= zipped.length && view.getUint32(offset, true) === 0x04034b50) {
			view.setUint32(offset + 22, declaredOriginalSize, true);
			offset +=
				30 +
				view.getUint16(offset + 26, true) +
				view.getUint16(offset + 28, true) +
				view.getUint32(offset + 18, true);
		}

		while (offset + 46 <= zipped.length && view.getUint32(offset, true) === 0x02014b50) {
			view.setUint32(offset + 24, declaredOriginalSize, true);
			offset +=
				46 +
				view.getUint16(offset + 28, true) +
				view.getUint16(offset + 30, true) +
				view.getUint16(offset + 32, true);
		}
	}

	return new File([Uint8Array.from(zipped)], name, { type: 'application/zip' });
}

function richTrackedZip() {
	return trackedZip({
		'exercises.csv': [
			'id,name,unilateral',
			'bench,Barbell Bench Press,false',
			'cyclone,Cable Cyclone,false'
		].join('\n'),
		'workouts.csv': ['id,name', 'upper,Upper A'].join('\n'),
		'sessions.csv': [
			'id,sessionDate,workoutId,startedAt,endedAt,completed',
			's1,2026-07-01,upper,2026-07-01 10:00:00+03,2026-07-01 11:15:00+03,true'
		].join('\n'),
		'sets.csv': [
			'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir,secondaryRepetitions,secondaryWeight,secondaryRir',
			'set1,s1,bench,Barbell Bench Press,8,80,2,,,',
			'set2,s1,cyclone,Cable Cyclone,10,15,1,9,14,2',
			'set3,missing,bench,Barbell Bench Press,5,90,1,,,'
		].join('\n'),
		'nutrition.csv': 'date,calories\n2026-07-01,2500'
	});
}

function expectNoDatabaseWrites() {
	for (const write of [
		dbMock.exercisesBulkAdd,
		dbMock.workoutsBulkAdd,
		dbMock.workoutExercisesBulkDelete,
		dbMock.workoutExercisesBulkPut,
		dbMock.workoutSessionsBulkAdd,
		dbMock.sessionExercisesBulkAdd,
		dbMock.sessionSetsBulkAdd,
		dbMock.transaction
	]) {
		expect(write).not.toHaveBeenCalled();
	}
}

describe('Tracked archive', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMock.currentUser.isLoggedIn = true;
		dbMock.exercisesToArray.mockResolvedValue([]);
		dbMock.exercisesBulkAdd.mockResolvedValue([]);
		dbMock.workoutsToArray.mockResolvedValue([]);
		dbMock.workoutsBulkAdd.mockResolvedValue([]);
		dbMock.workoutExercisesToArray.mockResolvedValue([]);
		dbMock.workoutExercisesBulkPut.mockResolvedValue([]);
		dbMock.workoutExercisesBulkDelete.mockResolvedValue(undefined);
		dbMock.workoutSessionsToArray.mockResolvedValue([]);
		dbMock.workoutSessionsBulkGet.mockResolvedValue([]);
		dbMock.workoutSessionsBulkAdd.mockResolvedValue([]);
		dbMock.sessionExercisesBulkAdd.mockResolvedValue([]);
		dbMock.sessionSetsBulkAdd.mockResolvedValue([]);
		dbMock.transaction.mockImplementation(async (...args: unknown[]) => {
			const callback = args.at(-1);

			if (typeof callback === 'function') {
				return callback();
			}
		});
		dbMock.syncNow.mockResolvedValue(undefined);
	});

	it.each([
		{
			name: 'rejects non-zip files',
			file: () => new File(['not a zip'], 'tracked.csv'),
			message: 'Choose a Tracked zip export.'
		},
		{
			name: 'reports missing required CSV files',
			file: () =>
				trackedZip({
					'sessions.csv': validCsv['sessions.csv'],
					'sets.csv': validCsv['sets.csv']
				}),
			message: 'Missing required Tracked CSV: exercises.csv.'
		},
		{
			name: 'reports missing required columns',
			file: () =>
				trackedZip({
					...validCsv,
					'sets.csv':
						'id,sessionId,exerciseId,exerciseName,repetitions,weight\nset1,s1,bench,Barbell Bench Press,8,80'
				}),
			message: 'sets.csv is missing required columns: rir.'
		},
		{
			name: 'reports unterminated quoted fields',
			file: () =>
				trackedZip({
					...validCsv,
					'exercises.csv': 'id,name\nbench,"Barbell Bench Press'
				}),
			message: 'exercises.csv has an unterminated quoted field.'
		}
	])('$name', async ({ file, message }) => {
		await expect(previewTrackedArchive(file())).rejects.toThrow(message);
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('rejects actual decompressed CSV bytes even when the declared size is smaller', async () => {
		const file = trackedZip(
			{
				...validCsv,
				'exercises.csv': `id,name\nbench,${'x'.repeat(12 * 1024 * 1024)}`
			},
			'tracked.zip',
			1
		);

		await expect(previewTrackedArchive(file)).rejects.toThrow(
			'Tracked CSV is too large: exercises.csv.'
		);
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('counts actual decompressed bytes toward the aggregate CSV limit', async () => {
		const file = trackedZip(
			{
				'exercises.csv': 'x'.repeat(11 * 1024 * 1024),
				'sessions.csv': 'x'.repeat(11 * 1024 * 1024),
				'sets.csv': 'x'.repeat(11 * 1024 * 1024)
			},
			'tracked.zip',
			1
		);

		await expect(previewTrackedArchive(file)).rejects.toThrow(
			'Tracked zip expands beyond the 32 MB safety limit.'
		);
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('rejects archives with excessive entry counts', async () => {
		const extraFiles = Object.fromEntries(
			Array.from({ length: 62 }, (_, index) => [`notes/${index}.txt`, 'ignored'])
		);
		const file = trackedZip({ ...validCsv, ...extraFiles });

		await expect(previewTrackedArchive(file)).rejects.toThrow(
			'Tracked zip contains too many files.'
		);
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('summarizes matching, custom, unilateral, skipped, and ignored data in one plan', async () => {
		const file = richTrackedZip();

		const summary = await previewTrackedArchive(file);

		expect(summary).toEqual(
			expect.objectContaining({
				fileName: 'tracked.zip',
				requiredFilesPresent: ['sessions.csv', 'sets.csv', 'exercises.csv'],
				optionalFilesPresent: ['workouts.csv'],
				ignoredFiles: ['nutrition.csv'],
				sessionsFound: 1,
				sessionsImportable: 1,
				sessionsImported: 0,
				sessionsSkipped: 0,
				strengthSetRowsFound: 3,
				strengthSetRowsImportable: 2,
				sessionSetsImported: 0,
				sessionSetsSkipped: 0,
				exercisesMatched: 1,
				exercisesMerged: 1,
				exercisesCreated: 1,
				workoutsMatched: 0,
				workoutsCreated: 1,
				exerciseLimbPriorities: [
					{
						normalizedName: 'cable cyclone',
						name: 'Cable Cyclone',
						setsWithSecondaryValues: 1,
						limbPriority: 'primary-right'
					}
				],
				warnings: [
					'1 set row references missing sessions or exercises.',
					'1 unsupported CSV file will be ignored.'
				],
				syncStatus: 'not-run'
			})
		);
		expect(summary.unsupportedCategories).toContain('nutrition');
		expect(dbMock.ensureDbOpen).toHaveBeenCalledOnce();
	});

	it('keeps warning wording plural for counts greater than one', async () => {
		const summary = await previewTrackedArchive(
			trackedZip({
				...validCsv,
				'sets.csv': [
					'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
					'set1,missing,bench,Barbell Bench Press,8,80,2',
					'set2,also-missing,bench,Barbell Bench Press,6,85,1'
				].join('\n'),
				'nutrition.csv': 'date,calories',
				'cardio.csv': 'date,duration'
			})
		);

		expect(summary.warnings).toEqual([
			'2 set rows reference missing sessions or exercises.',
			'2 unsupported CSV files will be ignored.'
		]);
	});

	it('plans only ID-backed exercises while resolving missing set names from the exercise catalog', async () => {
		const file = trackedZip({
			'exercises.csv': 'id,name\nbench,Barbell Bench Press',
			'sessions.csv': 'id,sessionDate\ns1,2026-07-01',
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
				'catalog-name,s1,bench,,8,80,2',
				'name-only,s1,,Cable Row,10,50,1'
			].join('\n')
		});

		const preview = await previewTrackedArchive(file);

		expect(preview).toEqual(
			expect.objectContaining({
				sessionsImportable: 1,
				strengthSetRowsFound: 2,
				strengthSetRowsImportable: 1,
				warnings: ['1 set row references missing sessions or exercises.']
			})
		);

		const summary = await importTrackedArchive(file);
		const sessionExercises = dbMock.sessionExercisesBulkAdd.mock.calls[0]?.[0];
		const sessionSets = dbMock.sessionSetsBulkAdd.mock.calls[0]?.[0];

		expect(summary.sessionSetsImported).toBe(1);
		expect(sessionExercises).toEqual([
			expect.objectContaining({ id: 'tracked:session:s1:exercise:bench' })
		]);
		expect(sessionSets).toEqual([
			expect.objectContaining({
				id: 'tracked:session:s1:exercise:bench:set:catalog-name:primary'
			})
		]);
	});

	it('skips sessions without a historical timestamp and falls back to a valid session date', async () => {
		const file = trackedZip({
			'exercises.csv': 'id,name\nbench,Barbell Bench Press',
			'sessions.csv': [
				'id,sessionDate,startedAt',
				'invalid,not-a-date,also-not-a-date',
				'fallback,2026-06-30,not-a-date'
			].join('\n'),
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
				'invalid-set,invalid,bench,Barbell Bench Press,8,80,2',
				'fallback-set,fallback,bench,Barbell Bench Press,6,85,1'
			].join('\n')
		});

		const preview = await previewTrackedArchive(file);

		expect(preview).toEqual(
			expect.objectContaining({
				sessionsFound: 2,
				sessionsImportable: 1,
				strengthSetRowsFound: 2,
				strengthSetRowsImportable: 1,
				warnings: ['1 session row with a missing or invalid historical timestamp was skipped.']
			})
		);

		const summary = await importTrackedArchive(file);
		const workoutSessions = dbMock.workoutSessionsBulkAdd.mock.calls[0]?.[0];

		expect(summary.sessionsImported).toBe(1);
		expect(workoutSessions).toEqual([
			expect.objectContaining({
				id: 'tracked:session:fallback',
				dayKey: '2026-06-30',
				startedAt: '2026-06-30T00:00:00.000Z',
				createdAt: '2026-06-30T00:00:00.000Z'
			})
		]);
	});

	it('stores numeric inputs and values from one validated canonical representation', async () => {
		const file = trackedZip({
			'exercises.csv': 'id,name,unilateral\ncustom,Custom Lift,true',
			'sessions.csv': 'id,sessionDate\ns1,2026-07-01',
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir,secondaryRepetitions,secondaryWeight,secondaryRir',
				'set1,s1,custom,Custom Lift,5.0,012.50,12.5,-3,7.50,oops'
			].join('\n')
		});

		const preview = await previewTrackedArchive(file);

		expect(preview.warnings).toContain('3 invalid numeric set values will be ignored.');

		const summary = await importTrackedArchive(file);
		const sessionSets = dbMock.sessionSetsBulkAdd.mock.calls[0]?.[0];

		expect(summary.sessionSetsImported).toBe(2);
		expect(sessionSets).toEqual([
			expect.objectContaining({
				side: 'right',
				weightInput: '12.5',
				weight: 12.5,
				repsInput: '5',
				reps: 5,
				rirInput: '',
				rir: undefined
			}),
			expect.objectContaining({
				side: 'left',
				weightInput: '7.5',
				weight: 7.5,
				repsInput: '',
				reps: undefined,
				rirInput: '',
				rir: undefined
			})
		]);
	});

	it('rebuilds workout templates from the newest imported session and removes stale rows', async () => {
		dbMock.workoutExercisesToArray.mockResolvedValue([
			{
				id: 'existing-newer',
				workoutId: 'tracked:workout:upper',
				exerciseId: 'tracked:exercise:newer lift',
				order: 2,
				createdAt: '2026-06-01T00:00:00.000Z',
				updatedAt: '2026-06-01T00:00:00.000Z'
			},
			{
				id: 'stale-older',
				workoutId: 'tracked:workout:upper',
				exerciseId: 'tracked:exercise:older lift',
				order: 1,
				createdAt: '2026-06-01T00:00:00.000Z',
				updatedAt: '2026-06-01T00:00:00.000Z'
			}
		]);
		const file = trackedZip({
			'exercises.csv': 'id,name\nnewer,Newer Lift\nolder,Older Lift',
			'workouts.csv': 'id,name\nupper,Upper',
			'sessions.csv': [
				'id,sessionDate,workoutId,startedAt',
				'newer-session,2026-07-02,upper,2026-07-02T10:00:00Z',
				'older-session,2026-07-01,upper,2026-07-01T10:00:00Z'
			].join('\n'),
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
				'newer-set,newer-session,newer,Newer Lift,8,80,2',
				'older-set,older-session,older,Older Lift,10,50,1'
			].join('\n')
		});

		await importTrackedArchive(file);

		expect(dbMock.workoutExercisesBulkDelete).toHaveBeenCalledWith(['stale-older']);
		expect(dbMock.workoutExercisesBulkPut).toHaveBeenCalledWith([
			expect.objectContaining({
				id: 'existing-newer',
				exerciseId: 'tracked:exercise:newer lift',
				order: 1
			})
		]);
	});

	it('preserves a workout template when a persisted session is newer than the import', async () => {
		dbMock.workoutExercisesToArray.mockResolvedValue([
			{
				id: 'persisted-template',
				workoutId: 'tracked:workout:upper',
				exerciseId: 'tracked:exercise:newer lift',
				order: 1,
				createdAt: '2026-07-03T10:00:00.000Z',
				updatedAt: '2026-07-03T10:00:00.000Z'
			}
		]);
		dbMock.workoutSessionsToArray.mockResolvedValue([
			{
				id: 'persisted-newer-session',
				workoutId: 'tracked:workout:upper',
				workoutNameSnapshot: 'Upper',
				dayKey: '2026-07-03',
				startedAt: '2026-07-03T10:00:00.000Z',
				completedAt: '2026-07-03T11:00:00.000Z',
				status: 'completed',
				createdAt: '2026-07-03T10:00:00.000Z',
				updatedAt: '2026-07-03T11:00:00.000Z'
			}
		]);
		const file = trackedZip({
			'exercises.csv': 'id,name\nolder,Older Lift',
			'workouts.csv': 'id,name\nupper,Upper',
			'sessions.csv': [
				'id,sessionDate,workoutId,startedAt',
				'older-session,2026-07-01,upper,2026-07-01T10:00:00Z'
			].join('\n'),
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
				'older-set,older-session,older,Older Lift,10,50,1'
			].join('\n')
		});

		await importTrackedArchive(file);

		expect(dbMock.workoutExercisesBulkDelete).not.toHaveBeenCalled();
		expect(dbMock.workoutExercisesBulkPut).not.toHaveBeenCalled();
	});

	it('imports a signed-in archive with deterministic rows and the selected limb priority', async () => {
		const progress: string[] = [];

		const summary = await importTrackedArchive(richTrackedZip(), {
			limbPriorities: { 'cable cyclone': 'primary-left' },
			onProgress: (phase) => progress.push(phase)
		});
		const workoutSessions = dbMock.workoutSessionsBulkAdd.mock.calls[0]?.[0];
		const sessionExercises = dbMock.sessionExercisesBulkAdd.mock.calls[0]?.[0];
		const sessionSets = dbMock.sessionSetsBulkAdd.mock.calls[0]?.[0];

		expect(progress).toEqual(['reading', 'planning', 'writing', 'syncing']);
		expect(summary).toEqual(
			expect.objectContaining({
				sessionsImported: 1,
				sessionsSkipped: 0,
				sessionSetsImported: 3,
				sessionSetsSkipped: 0,
				exercisesMatched: 1,
				exercisesCreated: 1,
				workoutsCreated: 1,
				exerciseLimbPriorities: [
					{
						normalizedName: 'cable cyclone',
						name: 'Cable Cyclone',
						setsWithSecondaryValues: 1,
						limbPriority: 'primary-left'
					}
				],
				syncStatus: 'synced'
			})
		);
		expect(dbMock.exercisesBulkAdd).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'tracked:exercise:cable cyclone' })
		]);
		expect(dbMock.workoutsBulkAdd).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'tracked:workout:upper a' })
		]);
		expect(dbMock.workoutExercisesBulkPut).toHaveBeenCalledWith([
			expect.objectContaining({
				workoutId: 'tracked:workout:upper a',
				order: 1
			}),
			expect.objectContaining({
				id: 'tracked:workout:upper a:exercise:tracked:exercise:cable cyclone',
				order: 2
			})
		]);

		expect(workoutSessions).toEqual([
			expect.objectContaining({
				id: 'tracked:session:s1',
				workoutId: 'tracked:workout:upper a',
				workoutNameSnapshot: 'Upper A',
				dayKey: '2026-07-01',
				startedAt: '2026-07-01T07:00:00.000Z',
				completedAt: '2026-07-01T08:15:00.000Z',
				status: 'completed',
				createdAt: '2026-07-01T07:00:00.000Z',
				updatedAt: '2026-07-01T08:15:00.000Z'
			})
		]);
		expect(sessionExercises).toEqual([
			expect.objectContaining({
				id: 'tracked:session:s1:exercise:bench',
				sessionId: 'tracked:session:s1',
				order: 1,
				performedAt: '2026-07-01T07:00:00.000Z'
			}),
			expect.objectContaining({
				id: 'tracked:session:s1:exercise:cyclone',
				sessionId: 'tracked:session:s1',
				exerciseId: 'tracked:exercise:cable cyclone',
				order: 2,
				performedAt: '2026-07-01T07:08:00.000Z'
			})
		]);
		expect(sessionSets).toEqual([
			expect.objectContaining({
				id: 'tracked:session:s1:exercise:bench:set:set1:primary',
				order: 1,
				side: 'bilateral',
				weightInput: '80',
				repsInput: '8',
				rirInput: '2',
				weight: 80,
				reps: 8,
				rir: 2
			}),
			expect.objectContaining({
				id: 'tracked:session:s1:exercise:cyclone:set:set2:primary',
				order: 1,
				side: 'left',
				weightInput: '15',
				repsInput: '10',
				rirInput: '1',
				weight: 15,
				reps: 10,
				rir: 1
			}),
			expect.objectContaining({
				id: 'tracked:session:s1:exercise:cyclone:set:set2:secondary',
				order: 1,
				side: 'right',
				weightInput: '14',
				repsInput: '9',
				rirInput: '2',
				weight: 14,
				reps: 9,
				rir: 2
			})
		]);
		expect(dbMock.transaction).toHaveBeenCalledOnce();
		expect(dbMock.syncNow).toHaveBeenCalledOnce();
	});

	it('rejects an archive with no importable data before writing', async () => {
		const file = trackedZip({
			...validCsv,
			'sets.csv':
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir\nset1,missing,bench,Barbell Bench Press,8,80,2'
		});

		await expect(importTrackedArchive(file)).rejects.toThrow(
			'No importable Tracked strength workouts were found.'
		);
		expectNoDatabaseWrites();
		expect(dbMock.syncNow).not.toHaveBeenCalled();
	});

	it('rejects a signed-out user before writing', async () => {
		dbMock.currentUser.isLoggedIn = false;

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow(
			'Sign in with Google before importing from Tracked.'
		);
		expectNoDatabaseWrites();
		expect(dbMock.syncNow).not.toHaveBeenCalled();
	});

	it('reports a failed synchronization after a successful import', async () => {
		dbMock.syncNow.mockRejectedValueOnce(new Error('Network unavailable'));

		const summary = await importTrackedArchive(richTrackedZip());

		expect(summary).toEqual(
			expect.objectContaining({ syncStatus: 'failed', syncError: 'Network unavailable' })
		);
		expect(dbMock.transaction).toHaveBeenCalledOnce();
		expect(dbMock.syncNow).toHaveBeenCalledOnce();
	});
});
