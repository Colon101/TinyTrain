import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
	ensureDbOpen: vi.fn(),
	syncNow: vi.fn(),
	exercisesToArray: vi.fn(),
	exercisesBulkAdd: vi.fn(),
	workoutsToArray: vi.fn(),
	workoutsBulkAdd: vi.fn(),
	workoutExercisesBulkPut: vi.fn(),
	workoutSessionsBulkGet: vi.fn(),
	workoutSessionsBulkAdd: vi.fn(),
	sessionExercisesBulkAdd: vi.fn(),
	sessionSetsBulkAdd: vi.fn(),
	transaction: vi.fn()
}));

vi.mock('./db', async () => {
	const { normalizeName } = await vi.importActual<typeof import('./db/shared')>('./db/shared');

	return {
		db: {
			cloud: { currentUser: { value: { isLoggedIn: true } } },
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
					equals: () => ({
						toArray: async () => []
					})
				}),
				bulkPut: dbMock.workoutExercisesBulkPut
			},
			workoutSessions: {
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
		toDayKey: vi.fn()
	};
});

import { importTrackedArchive, previewTrackedArchive } from './tracked-import';

const validCsv = {
	'exercises.csv': 'id,name\nbench,Barbell Bench Press',
	'sessions.csv': 'id,sessionDate\ns1,2026-07-01',
	'sets.csv':
		'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir\nset1,s1,bench,Barbell Bench Press,8,80,2'
};

function trackedZip(files: Record<string, string>, name = 'tracked.zip') {
	const zipped = zipSync(
		Object.fromEntries(Object.entries(files).map(([path, contents]) => [path, strToU8(contents)]))
	);

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

describe('Tracked archive', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMock.exercisesToArray.mockResolvedValue([]);
		dbMock.exercisesBulkAdd.mockResolvedValue([]);
		dbMock.workoutsToArray.mockResolvedValue([]);
		dbMock.workoutsBulkAdd.mockResolvedValue([]);
		dbMock.workoutExercisesBulkPut.mockResolvedValue([]);
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
					'1 set rows reference missing sessions or exercises.',
					'1 unsupported CSV files will be ignored.'
				],
				syncStatus: 'not-run'
			})
		);
		expect(summary.unsupportedCategories).toContain('nutrition');
		expect(dbMock.ensureDbOpen).toHaveBeenCalledOnce();
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
});
