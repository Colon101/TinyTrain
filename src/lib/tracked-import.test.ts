import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
	currentUser: { isLoggedIn: true, userId: 'user-1' },
	ensureDbOpen: vi.fn(),
	syncNow: vi.fn(),
	exercisesToArray: vi.fn(),
	exercisesBulkGet: vi.fn(),
	exercisesBulkAdd: vi.fn(),
	exercisesBulkDelete: vi.fn(),
	workoutsToArray: vi.fn(),
	workoutsBulkGet: vi.fn(),
	workoutsBulkAdd: vi.fn(),
	workoutsBulkDelete: vi.fn(),
	workoutExerciseRows: [] as Array<{ id: string; [key: string]: unknown }>,
	workoutExercisesToArray: vi.fn(),
	workoutExercisesBulkGet: vi.fn(),
	workoutExercisesBulkGetVersioned: vi.fn(),
	workoutExercisesBulkPut: vi.fn(),
	workoutExercisesBulkDelete: vi.fn(),
	workoutExercisesCompareAndPut: vi.fn(),
	workoutExercisesCompareAndDelete: vi.fn(),
	workoutSessionsToArray: vi.fn(),
	workoutSessionsBulkGet: vi.fn(),
	workoutSessionsBulkAdd: vi.fn(),
	workoutSessionsBulkDelete: vi.fn(),
	sessionExercisesBulkGet: vi.fn(),
	sessionExercisesBulkAdd: vi.fn(),
	sessionExercisesBulkDelete: vi.fn(),
	sessionSetsBulkGet: vi.fn(),
	sessionSetsBulkAdd: vi.fn(),
	sessionSetsBulkDelete: vi.fn(),
	transaction: vi.fn()
}));

vi.mock('./db', async () => {
	const { normalizeName, toDayKey } =
		await vi.importActual<typeof import('./db/shared')>('./db/shared');
	const database = {
		exercises: {
			toArray: dbMock.exercisesToArray,
			bulkGet: dbMock.exercisesBulkGet,
			bulkAdd: dbMock.exercisesBulkAdd,
			bulkDelete: dbMock.exercisesBulkDelete
		},
		workouts: {
			toArray: dbMock.workoutsToArray,
			bulkGet: dbMock.workoutsBulkGet,
			bulkAdd: dbMock.workoutsBulkAdd,
			bulkDelete: dbMock.workoutsBulkDelete
		},
		workoutExercises: {
			where: () => ({
				anyOf: (workoutIds: string[]) => ({
					toArray: () => dbMock.workoutExercisesToArray(workoutIds)
				})
			}),
			bulkGet: dbMock.workoutExercisesBulkGet,
			bulkGetVersioned: dbMock.workoutExercisesBulkGetVersioned,
			bulkPut: dbMock.workoutExercisesBulkPut,
			bulkDelete: dbMock.workoutExercisesBulkDelete,
			compareAndPut: dbMock.workoutExercisesCompareAndPut,
			compareAndDelete: dbMock.workoutExercisesCompareAndDelete
		},
		workoutSessions: {
			where: () => ({
				anyOf: () => ({
					toArray: dbMock.workoutSessionsToArray
				})
			}),
			bulkGet: dbMock.workoutSessionsBulkGet,
			bulkAdd: dbMock.workoutSessionsBulkAdd,
			bulkDelete: dbMock.workoutSessionsBulkDelete
		},
		sessionExercises: {
			bulkGet: dbMock.sessionExercisesBulkGet,
			bulkAdd: dbMock.sessionExercisesBulkAdd,
			bulkDelete: dbMock.sessionExercisesBulkDelete
		},
		sessionSets: {
			bulkGet: dbMock.sessionSetsBulkGet,
			bulkAdd: dbMock.sessionSetsBulkAdd,
			bulkDelete: dbMock.sessionSetsBulkDelete
		},
		transaction: dbMock.transaction
	};

	return {
		acquireActiveDatabaseLease: (expectedUserId: string) => ({
			userId: expectedUserId,
			database,
			syncNow: dbMock.syncNow,
			assertActive() {
				if (!dbMock.currentUser.isLoggedIn || dbMock.currentUser.userId !== expectedUserId) {
					throw new Error('The signed-in account changed during the Tracked import.');
				}
			}
		}),
		currentUser: { value: dbMock.currentUser },
		db: database,
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
		dbMock.exercisesBulkDelete,
		dbMock.workoutsBulkAdd,
		dbMock.workoutsBulkDelete,
		dbMock.workoutExercisesBulkDelete,
		dbMock.workoutExercisesBulkPut,
		dbMock.workoutExercisesCompareAndPut,
		dbMock.workoutExercisesCompareAndDelete,
		dbMock.workoutSessionsBulkAdd,
		dbMock.workoutSessionsBulkDelete,
		dbMock.sessionExercisesBulkAdd,
		dbMock.sessionExercisesBulkDelete,
		dbMock.sessionSetsBulkAdd,
		dbMock.sessionSetsBulkDelete,
		dbMock.transaction
	]) {
		expect(write).not.toHaveBeenCalled();
	}
}

describe('Tracked archive', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMock.currentUser.isLoggedIn = true;
		dbMock.currentUser.userId = 'user-1';
		dbMock.exercisesToArray.mockResolvedValue([]);
		dbMock.exercisesBulkGet.mockImplementation(async (ids: string[]) => ids.map(() => undefined));
		dbMock.exercisesBulkAdd.mockResolvedValue([]);
		dbMock.exercisesBulkDelete.mockResolvedValue(undefined);
		dbMock.workoutsToArray.mockResolvedValue([]);
		dbMock.workoutsBulkGet.mockImplementation(async (ids: string[]) => ids.map(() => undefined));
		dbMock.workoutsBulkAdd.mockResolvedValue([]);
		dbMock.workoutsBulkDelete.mockResolvedValue(undefined);
		dbMock.workoutExerciseRows.splice(0);
		dbMock.workoutExercisesToArray.mockImplementation(async (workoutIds?: string[]) =>
			workoutIds
				? dbMock.workoutExerciseRows.filter((row) => workoutIds.includes(String(row.workoutId)))
				: dbMock.workoutExerciseRows
		);
		dbMock.workoutExercisesBulkGet.mockImplementation(async (ids: string[]) => {
			const rows = await dbMock.workoutExercisesToArray();
			return ids.map((id) => rows.find((row: { id: string }) => row.id === id));
		});
		dbMock.workoutExercisesBulkGetVersioned.mockImplementation(async (ids: string[]) => {
			const rows = await dbMock.workoutExercisesBulkGet(ids);
			return rows.map((document: { id: string } | undefined) =>
				document ? { document, version: `version:${document.id}` } : undefined
			);
		});
		dbMock.workoutExercisesBulkPut.mockResolvedValue([]);
		dbMock.workoutExercisesBulkDelete.mockResolvedValue(undefined);
		dbMock.workoutExercisesCompareAndPut.mockImplementation(
			async (_expectedVersion: string | undefined, row: { id: string }) => {
				const index = dbMock.workoutExerciseRows.findIndex(({ id }) => id === row.id);

				if (index === -1) {
					dbMock.workoutExerciseRows.push(row);
				} else {
					dbMock.workoutExerciseRows[index] = row;
				}

				return true;
			}
		);
		dbMock.workoutExercisesCompareAndDelete.mockImplementation(
			async (_expectedVersion: string, id: string) => {
				const index = dbMock.workoutExerciseRows.findIndex((row) => row.id === id);

				if (index !== -1) {
					dbMock.workoutExerciseRows.splice(index, 1);
				}

				return true;
			}
		);
		dbMock.workoutSessionsToArray.mockResolvedValue([]);
		dbMock.workoutSessionsBulkGet.mockImplementation(async (ids: string[]) =>
			ids.map(() => undefined)
		);
		dbMock.workoutSessionsBulkAdd.mockResolvedValue([]);
		dbMock.workoutSessionsBulkDelete.mockResolvedValue(undefined);
		dbMock.sessionExercisesBulkGet.mockImplementation(async (ids: string[]) =>
			ids.map(() => undefined)
		);
		dbMock.sessionExercisesBulkAdd.mockResolvedValue([]);
		dbMock.sessionExercisesBulkDelete.mockResolvedValue(undefined);
		dbMock.sessionSetsBulkGet.mockImplementation(async (ids: string[]) => ids.map(() => undefined));
		dbMock.sessionSetsBulkAdd.mockResolvedValue([]);
		dbMock.sessionSetsBulkDelete.mockResolvedValue(undefined);
		dbMock.transaction.mockImplementation(async (callback: () => Promise<unknown>) => callback());
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

	it('rejects a CSV before materialization when its per-file row limit is exceeded', async () => {
		const exercises = [
			'id,name',
			...Array.from({ length: 50_000 }, (_, index) => `exercise-${index},Lift`)
		].join('\n');

		await expect(
			previewTrackedArchive(trackedZip({ ...validCsv, 'exercises.csv': exercises }))
		).rejects.toThrow('exercises.csv exceeds the 50,000-row limit.');
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('rejects aggregate CSV rows before materialization', async () => {
		const rows = Array.from({ length: 33_333 }, (_, index) => index);
		const file = trackedZip({
			'exercises.csv': ['id,name', ...rows.map((index) => `exercise-${index},Lift`)].join('\n'),
			'sessions.csv': [
				'id,sessionDate',
				...rows.map((index) => `session-${index},2026-07-01`)
			].join('\n'),
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
				...rows.map((index) => `set-${index},session-${index},exercise-${index},Lift,1,1,1`)
			].join('\n')
		});

		await expect(previewTrackedArchive(file)).rejects.toThrow(
			'Tracked CSV files exceed the 100,000-row aggregate limit.'
		);
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('rejects excessive CSV columns before materialization', async () => {
		const columns = Array.from({ length: 33 }, (_, index) => `column-${index}`);
		const file = trackedZip({
			...validCsv,
			'exercises.csv': [columns.join(','), columns.map(() => 'value').join(',')].join('\n')
		});

		await expect(previewTrackedArchive(file)).rejects.toThrow(
			'exercises.csv exceeds the 32-column limit.'
		);
		expect(dbMock.ensureDbOpen).not.toHaveBeenCalled();
	});

	it('rejects oversized CSV fields before materialization', async () => {
		const file = trackedZip({
			...validCsv,
			'exercises.csv': `id,name\nbench,${'x'.repeat(16_385)}`
		});

		await expect(previewTrackedArchive(file)).rejects.toThrow(
			'exercises.csv contains a field longer than 16,384 characters.'
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
			expect.objectContaining({ id: 'tracked:user-1:session:s1:exercise:bench' })
		]);
		expect(sessionSets).toEqual([
			expect.objectContaining({
				id: 'tracked:user-1:session:s1:exercise:bench:set:catalog-name:primary'
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
				id: 'tracked:user-1:session:fallback',
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
		dbMock.workoutExerciseRows.push(
			{
				id: 'existing-newer',
				workoutId: 'tracked:user-1:workout:upper',
				exerciseId: 'tracked:user-1:exercise:newer lift',
				order: 2,
				createdAt: '2026-06-01T00:00:00.000Z',
				updatedAt: '2026-06-01T00:00:00.000Z'
			},
			{
				id: 'stale-older',
				workoutId: 'tracked:user-1:workout:upper',
				exerciseId: 'tracked:user-1:exercise:older lift',
				order: 1,
				createdAt: '2026-06-01T00:00:00.000Z',
				updatedAt: '2026-06-01T00:00:00.000Z'
			}
		);
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

		expect(dbMock.workoutExercisesCompareAndDelete).toHaveBeenCalledWith(
			'version:stale-older',
			'stale-older'
		);
		expect(dbMock.workoutExercisesCompareAndPut).toHaveBeenCalledWith(
			'version:existing-newer',
			expect.objectContaining({
				id: 'existing-newer',
				exerciseId: 'tracked:user-1:exercise:newer lift',
				order: 1
			})
		);
	});

	it('preserves a workout template when a persisted session is newer than the import', async () => {
		dbMock.workoutExerciseRows.push({
			id: 'persisted-template',
			workoutId: 'tracked:user-1:workout:upper',
			exerciseId: 'tracked:user-1:exercise:newer lift',
			order: 1,
			createdAt: '2026-07-03T10:00:00.000Z',
			updatedAt: '2026-07-03T10:00:00.000Z'
		});
		dbMock.workoutSessionsToArray.mockResolvedValue([
			{
				id: 'persisted-newer-session',
				workoutId: 'tracked:user-1:workout:upper',
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

		expect(dbMock.workoutExercisesCompareAndDelete).not.toHaveBeenCalled();
		expect(dbMock.workoutExercisesCompareAndPut).not.toHaveBeenCalled();
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
			expect.objectContaining({ id: 'tracked:user-1:exercise:cable cyclone' })
		]);
		expect(dbMock.workoutsBulkAdd).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'tracked:user-1:workout:upper a' })
		]);
		expect(dbMock.workoutExercisesCompareAndPut).toHaveBeenCalledTimes(2);
		expect(dbMock.workoutExercisesCompareAndPut).toHaveBeenNthCalledWith(
			1,
			undefined,
			expect.objectContaining({
				workoutId: 'tracked:user-1:workout:upper a',
				order: 1
			})
		);
		expect(dbMock.workoutExercisesCompareAndPut).toHaveBeenNthCalledWith(
			2,
			undefined,
			expect.objectContaining({
				id: 'tracked:user-1:workout:upper a:exercise:tracked:user-1:exercise:cable cyclone',
				order: 2
			})
		);

		expect(workoutSessions).toEqual([
			expect.objectContaining({
				id: 'tracked:user-1:session:s1',
				workoutId: 'tracked:user-1:workout:upper a',
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
				id: 'tracked:user-1:session:s1:exercise:bench',
				sessionId: 'tracked:user-1:session:s1',
				order: 1,
				performedAt: '2026-07-01T07:00:00.000Z'
			}),
			expect.objectContaining({
				id: 'tracked:user-1:session:s1:exercise:cyclone',
				sessionId: 'tracked:user-1:session:s1',
				exerciseId: 'tracked:user-1:exercise:cable cyclone',
				order: 2,
				performedAt: '2026-07-01T07:08:00.000Z'
			})
		]);
		expect(sessionSets).toEqual([
			expect.objectContaining({
				id: 'tracked:user-1:session:s1:exercise:bench:set:set1:primary',
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
				id: 'tracked:user-1:session:s1:exercise:cyclone:set:set2:primary',
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
				id: 'tracked:user-1:session:s1:exercise:cyclone:set:set2:secondary',
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

	it('namespaces deterministic imported IDs to the authenticated owner', async () => {
		dbMock.currentUser.userId = 'user-a';
		await importTrackedArchive(richTrackedZip());
		const firstExerciseId = dbMock.exercisesBulkAdd.mock.calls[0]?.[0]?.[0]?.id;
		const firstWorkoutId = dbMock.workoutsBulkAdd.mock.calls[0]?.[0]?.[0]?.id;
		const firstSessionId = dbMock.workoutSessionsBulkAdd.mock.calls[0]?.[0]?.[0]?.id;

		dbMock.currentUser.userId = 'user-b';
		await importTrackedArchive(richTrackedZip());
		const secondExerciseId = dbMock.exercisesBulkAdd.mock.calls[1]?.[0]?.[0]?.id;
		const secondWorkoutId = dbMock.workoutsBulkAdd.mock.calls[1]?.[0]?.[0]?.id;
		const secondSessionId = dbMock.workoutSessionsBulkAdd.mock.calls[1]?.[0]?.[0]?.id;

		expect(firstExerciseId).toBe('tracked:user-a:exercise:cable cyclone');
		expect(firstWorkoutId).toBe('tracked:user-a:workout:upper a');
		expect(firstSessionId).toBe('tracked:user-a:session:s1');
		expect(secondExerciseId).toBe('tracked:user-b:exercise:cable cyclone');
		expect(secondWorkoutId).toBe('tracked:user-b:workout:upper a');
		expect(secondSessionId).toBe('tracked:user-b:session:s1');
	});

	it('aborts before writing if the authenticated account changes during planning', async () => {
		dbMock.workoutSessionsBulkGet.mockImplementationOnce(async (ids: string[]) => {
			dbMock.currentUser.userId = 'user-2';
			return ids.map(() => undefined);
		});

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow(
			'The signed-in account changed during the Tracked import.'
		);

		expectNoDatabaseWrites();
		expect(dbMock.syncNow).not.toHaveBeenCalled();
	});

	it('prevalidates every derived document before the first database write', async () => {
		const oversizedSetId = 's'.repeat(480);
		const file = trackedZip({
			...validCsv,
			'sets.csv': [
				'id,sessionId,exerciseId,exerciseName,repetitions,weight,rir',
				`${oversizedSetId},s1,bench,Barbell Bench Press,8,80,2`
			].join('\n')
		});

		await expect(importTrackedArchive(file)).rejects.toThrow(
			'sessionSets import document id exceeds 500 characters.'
		);
		for (const write of [
			dbMock.exercisesBulkAdd,
			dbMock.workoutsBulkAdd,
			dbMock.workoutExercisesCompareAndDelete,
			dbMock.workoutExercisesCompareAndPut,
			dbMock.workoutSessionsBulkAdd,
			dbMock.sessionExercisesBulkAdd,
			dbMock.sessionSetsBulkAdd
		]) {
			expect(write).not.toHaveBeenCalled();
		}
		expect(dbMock.syncNow).not.toHaveBeenCalled();
	});

	it('keeps a partial import retryable and exposes the session only after its children exist', async () => {
		type StoredRow = { id: string; user_id?: string; [key: string]: unknown };
		const stores = {
			exercises: new Map<string, StoredRow>(),
			workouts: new Map<string, StoredRow>(),
			workoutSessions: new Map<string, StoredRow>(),
			sessionExercises: new Map<string, StoredRow>(),
			sessionSets: new Map<string, StoredRow>()
		};
		const connectTable = (
			bulkGet: typeof dbMock.exercisesBulkGet,
			bulkAdd: typeof dbMock.exercisesBulkAdd,
			store: Map<string, StoredRow>
		) => {
			bulkGet.mockImplementation(async (ids: string[]) => ids.map((id) => store.get(id)));
			bulkAdd.mockImplementation(async (rows: StoredRow[]) => {
				for (const row of rows) {
					store.set(row.id, { ...row, user_id: 'user-1' });
				}

				return rows.map(({ id }) => id);
			});
		};

		connectTable(dbMock.exercisesBulkGet, dbMock.exercisesBulkAdd, stores.exercises);
		connectTable(dbMock.workoutsBulkGet, dbMock.workoutsBulkAdd, stores.workouts);
		connectTable(
			dbMock.workoutSessionsBulkGet,
			dbMock.workoutSessionsBulkAdd,
			stores.workoutSessions
		);
		connectTable(
			dbMock.sessionExercisesBulkGet,
			dbMock.sessionExercisesBulkAdd,
			stores.sessionExercises
		);
		connectTable(dbMock.sessionSetsBulkGet, dbMock.sessionSetsBulkAdd, stores.sessionSets);
		dbMock.exercisesToArray.mockImplementation(async () => [...stores.exercises.values()]);
		dbMock.workoutsToArray.mockImplementation(async () => [...stores.workouts.values()]);
		dbMock.sessionSetsBulkAdd.mockImplementationOnce(async (rows: StoredRow[]) => {
			stores.sessionSets.set(rows[0].id, { ...rows[0], user_id: 'user-1' });
			throw new Error('set write failed');
		});

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow('set write failed');
		expect(stores.sessionSets.size).toBe(1);
		expect(stores.workoutSessions.size).toBe(0);
		expect(dbMock.syncNow).not.toHaveBeenCalled();

		const summary = await importTrackedArchive(richTrackedZip());

		expect(summary.sessionsImported).toBe(1);
		expect(stores.sessionSets.size).toBe(3);
		expect(stores.workoutSessions.size).toBe(1);
		expect(dbMock.sessionSetsBulkAdd.mock.calls[1]?.[0]).toHaveLength(2);
		expect(dbMock.workoutSessionsBulkAdd).toHaveBeenCalledOnce();
		expect(dbMock.sessionSetsBulkDelete).not.toHaveBeenCalled();
		expect(dbMock.workoutSessionsBulkDelete).not.toHaveBeenCalled();
	});

	it('preserves a competing document when a deterministic insert loses a race', async () => {
		let competingWorkout: { id: string; name: string } | undefined;
		dbMock.workoutsBulkGet.mockImplementation(async (ids: string[]) =>
			ids.map((id) => (id === competingWorkout?.id ? competingWorkout : undefined))
		);
		dbMock.workoutsBulkAdd.mockImplementationOnce(
			async (rows: Array<{ id: string; name: string }>) => {
				competingWorkout = { ...rows[0], name: 'Concurrent tab winner' };
				throw new Error('insert conflict');
			}
		);

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow(
			'workouts import IDs conflict with existing data.'
		);

		expect(competingWorkout?.name).toBe('Concurrent tab winner');
		expect(dbMock.workoutsBulkDelete).not.toHaveBeenCalled();
		expect(dbMock.workoutSessionsBulkAdd).not.toHaveBeenCalled();
		expect(dbMock.sessionExercisesBulkAdd).not.toHaveBeenCalled();
		expect(dbMock.sessionSetsBulkAdd).not.toHaveBeenCalled();
		expect(dbMock.workoutExercisesCompareAndPut).not.toHaveBeenCalled();
	});

	it('preserves a concurrently edited workout template when its revision changes', async () => {
		const existingTemplate = {
			id: 'existing-template',
			workoutId: 'tracked:user-1:workout:upper a',
			exerciseId: 'older-exercise',
			order: 1,
			createdAt: '2026-06-01T00:00:00.000Z',
			updatedAt: '2026-06-01T00:00:00.000Z'
		};
		let currentTemplate = existingTemplate;
		let currentVersion = 'revision-1';
		dbMock.workoutExerciseRows.push(existingTemplate);
		dbMock.workoutExercisesBulkGetVersioned.mockImplementation(async (ids: string[]) =>
			ids.map((id) =>
				id === currentTemplate.id
					? { document: currentTemplate, version: currentVersion }
					: undefined
			)
		);
		dbMock.workoutExercisesCompareAndDelete.mockImplementationOnce(async () => {
			currentTemplate = {
				...existingTemplate,
				order: 9,
				updatedAt: '2026-08-16T00:00:00.000Z'
			};
			currentVersion = 'revision-2';
			return false;
		});

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow(
			'workoutExercises import conflicts with concurrently changed data.'
		);

		expect(currentTemplate.order).toBe(9);
		expect(dbMock.workoutExercisesBulkDelete).not.toHaveBeenCalled();
		expect(dbMock.syncNow).not.toHaveBeenCalled();
	});

	it('detects a concurrently inserted template row before exposing the session', async () => {
		let puts = 0;
		dbMock.workoutExercisesCompareAndPut.mockImplementation(
			async (_expectedVersion: string | undefined, row: { id: string; workoutId: string }) => {
				dbMock.workoutExerciseRows.push(row);
				puts += 1;

				if (puts === 2) {
					dbMock.workoutExerciseRows.push({
						id: 'concurrent-template-row',
						workoutId: row.workoutId,
						exerciseId: 'concurrent-exercise',
						order: 99,
						createdAt: '2026-08-16T00:00:00.000Z',
						updatedAt: '2026-08-16T00:00:00.000Z'
					});
				}

				return true;
			}
		);

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow(
			'workoutExercises import conflicts with concurrently changed data.'
		);

		expect(dbMock.workoutExerciseRows.some(({ id }) => id === 'concurrent-template-row')).toBe(
			true
		);
		expect(dbMock.workoutSessionsBulkAdd).not.toHaveBeenCalled();
		expect(dbMock.syncNow).not.toHaveBeenCalled();
	});

	it('rejects a template row that disappears while its revision snapshot is captured', async () => {
		dbMock.workoutExerciseRows.push({
			id: 'disappearing-template',
			workoutId: 'tracked:user-1:workout:upper a',
			exerciseId: 'older-exercise',
			order: 1,
			createdAt: '2026-06-01T00:00:00.000Z',
			updatedAt: '2026-06-01T00:00:00.000Z'
		});
		dbMock.workoutExercisesBulkGetVersioned.mockResolvedValueOnce([undefined]);

		await expect(importTrackedArchive(richTrackedZip())).rejects.toThrow(
			'workoutExercises import conflicts with concurrently changed data.'
		);

		expect(dbMock.workoutExercisesCompareAndPut).not.toHaveBeenCalled();
		expect(dbMock.workoutExercisesCompareAndDelete).not.toHaveBeenCalled();
		expect(dbMock.workoutSessionsBulkAdd).not.toHaveBeenCalled();
	});

	it('keeps legacy unnamespaced imports idempotent while new IDs are owner-scoped', async () => {
		const legacySession = {
			id: 'tracked:session:s1',
			workoutId: 'tracked:workout:upper a',
			workoutNameSnapshot: 'Upper A',
			dayKey: '2026-07-01',
			startedAt: '2026-07-01T07:00:00.000Z',
			completedAt: '2026-07-01T08:15:00.000Z',
			status: 'completed',
			createdAt: '2026-07-01T07:00:00.000Z',
			updatedAt: '2026-07-01T08:15:00.000Z'
		};
		dbMock.workoutSessionsBulkGet.mockImplementation(async (ids: string[]) =>
			ids.map((id) => (id === legacySession.id ? legacySession : undefined))
		);

		const summary = await importTrackedArchive(richTrackedZip());

		expect(summary).toEqual(
			expect.objectContaining({
				sessionsImported: 0,
				sessionsSkipped: 1,
				sessionSetsImported: 0,
				sessionSetsSkipped: 3
			})
		);
		expect(dbMock.workoutSessionsBulkAdd).not.toHaveBeenCalled();
		expect(dbMock.sessionExercisesBulkAdd).not.toHaveBeenCalled();
		expect(dbMock.sessionSetsBulkAdd).not.toHaveBeenCalled();
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
