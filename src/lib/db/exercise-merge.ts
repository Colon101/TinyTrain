import { BASELINE_EXERCISE_BY_ID, BASELINE_EXERCISE_BY_NORMALIZED_NAME } from '../exercises';
import {
	getCompensationJournalDurabilityMessage,
	persistCompensationJournalEntry,
	readCompensationJournalEntries,
	removeCompensationJournalEntry,
	type CompensationJournalEntry
} from './compensation-journal';
import { getExercise, getPerformedSessionExerciseIdSet, listExercises } from './exercises';
import type {
	Exercise,
	ExerciseMergeInput,
	ExerciseMergeOption,
	ExerciseMergeResult,
	SessionExercise,
	SessionSet,
	WorkoutSession
} from './models';
import {
	db,
	requireLoggedInUser,
	runAuthenticatedDatabaseOperation,
	syncNow,
	type AuthenticatedDatabaseOperation,
	type AuthenticatedOperationDatabase
} from './runtime';
import {
	compareOptionalRecency,
	displayName,
	filterSessionSetsForSessionExercises,
	hasPerformedSetValues,
	isDefined,
	normalizeName,
	timestamp,
	withExerciseDefaults,
	withSessionSetDefaults
} from './shared';

export async function listExerciseMergeOptions(): Promise<ExerciseMergeOption[]> {
	const [exercises, sessionExercises] = await Promise.all([
		listExercises(),
		db.sessionExercises.toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByExerciseId = new Map<
		string,
		{
			historySessionIds: Set<string>;
			lastPerformedAt?: string;
		}
	>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const usage = usageByExerciseId.get(sessionExercise.exerciseId) ?? {
			historySessionIds: new Set<string>(),
			lastPerformedAt: undefined
		};

		usage.historySessionIds.add(sessionExercise.sessionId);

		if (!usage.lastPerformedAt || usage.lastPerformedAt < performedAt) {
			usage.lastPerformedAt = performedAt;
		}

		usageByExerciseId.set(sessionExercise.exerciseId, usage);
	}

	return exercises
		.map((exercise) => {
			const usage = usageByExerciseId.get(exercise.id);

			return {
				exercise,
				historyCount: usage?.historySessionIds.size ?? 0,
				lastPerformedAt: usage?.lastPerformedAt,
				canRename: !BASELINE_EXERCISE_BY_ID.has(exercise.id) && exercise.source === 'custom'
			};
		})
		.sort(
			(first, second) =>
				compareOptionalRecency(first.lastPerformedAt, second.lastPerformedAt) ||
				second.historyCount - first.historyCount ||
				first.exercise.name.localeCompare(second.exercise.name)
		);
}

export function getMergedSessionExerciseId(
	mainExerciseId: string,
	secondarySessionExerciseId: string
) {
	return `merge:${mainExerciseId}:${secondarySessionExerciseId}`;
}

export function getMergedSessionSetId(
	mainSessionExerciseId: string,
	secondarySessionSetId: string
) {
	return `${mainSessionExerciseId}:set:${secondarySessionSetId}`;
}

type ExerciseMergeMutation =
	| { table: 'exercises'; before: Exercise | undefined; after: Exercise }
	| { table: 'sessionExercises'; before: SessionExercise | undefined; after: SessionExercise }
	| { table: 'sessionSets'; before: SessionSet | undefined; after: SessionSet }
	| { table: 'workoutSessions'; before: WorkoutSession | undefined; after: WorkoutSession };

type ExerciseMergeCompensationAttempt = {
	userId: string;
	mainExerciseId: string;
	secondaryExerciseId: string;
	mutations: ExerciseMergeMutation[];
};

type ExerciseMergeCompensationReport = {
	cleanupErrors: unknown[];
	remainingRowIds: string[];
};

type ExerciseMergeCopyGroup = {
	secondarySessionExercise: SessionExercise;
	sourceSets: SessionSet[];
	copiedSessionExerciseId: string;
};

const pendingExerciseMergeCompensations = new Map<string, Set<ExerciseMergeCompensationError>>();

function getExerciseMergeScopeKey(
	userId: string,
	mainExerciseId: string,
	secondaryExerciseId: string
) {
	return `${userId}\u0000${mainExerciseId}\u0000${secondaryExerciseId}`;
}

function getExerciseMergeMutationKey(mutation: ExerciseMergeMutation) {
	return `${mutation.table}:${mutation.after.id}`;
}

function rowsExactlyMatch<T extends { id: string }>(current: T, expected: T) {
	const keys = new Set([...Object.keys(current), ...Object.keys(expected)]);

	return [...keys].every(
		(key) =>
			(current as unknown as Record<string, unknown>)[key] ===
			(expected as unknown as Record<string, unknown>)[key]
	);
}

export class ExerciseMergeCompensationError extends Error {
	readonly cleanupErrors: unknown[];
	remainingRowIds: string[];
	journalEntry: CompensationJournalEntry<ExerciseMergeCompensationAttempt> | null = null;
	readonly durabilityErrors: unknown[] = [];

	constructor(
		readonly originalError: unknown,
		cleanupErrors: unknown[],
		remainingRowIds: string[],
		readonly attempt: ExerciseMergeCompensationAttempt
	) {
		super(
			'Exercise history merge failed, and TinyTrain could not fully restore the prior data. Retry the merge so the remaining temporary changes can be repaired.',
			{ cause: new AggregateError([originalError, ...cleanupErrors]) }
		);
		this.name = 'ExerciseMergeCompensationError';
		this.cleanupErrors = [...cleanupErrors];
		this.remainingRowIds = [...remainingRowIds];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredExerciseMergeRow(
	value: unknown
): value is { id: string } & Record<string, unknown> {
	return isRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}

function isExerciseMergeMutation(value: unknown): value is ExerciseMergeMutation {
	return Boolean(
		isRecord(value) &&
		(value.table === 'exercises' ||
			value.table === 'sessionExercises' ||
			value.table === 'sessionSets' ||
			value.table === 'workoutSessions') &&
		isStoredExerciseMergeRow(value.after) &&
		(value.before === undefined || isStoredExerciseMergeRow(value.before)) &&
		(value.before === undefined || value.before.id === value.after.id)
	);
}

function isExerciseMergeCompensationAttempt(
	value: unknown
): value is ExerciseMergeCompensationAttempt {
	return Boolean(
		isRecord(value) &&
		typeof value.userId === 'string' &&
		typeof value.mainExerciseId === 'string' &&
		typeof value.secondaryExerciseId === 'string' &&
		value.mainExerciseId !== value.secondaryExerciseId &&
		Array.isArray(value.mutations) &&
		value.mutations.length > 0 &&
		value.mutations.every(isExerciseMergeMutation)
	);
}

function markExerciseMergeCompensationNonDurable(
	error: ExerciseMergeCompensationError,
	durabilityError: unknown
) {
	error.durabilityErrors.push(durabilityError);

	if (!error.message.includes('Recovery could not be saved for reload safety.')) {
		error.message += getCompensationJournalDurabilityMessage(durabilityError);
	}
}

function persistExerciseMergeCompensation(error: ExerciseMergeCompensationError) {
	if (error.journalEntry) {
		return;
	}

	try {
		error.journalEntry = persistCompensationJournalEntry({
			kind: 'exercise-merge',
			userId: error.attempt.userId,
			operationKey: getExerciseMergeScopeKey(
				error.attempt.userId,
				error.attempt.mainExerciseId,
				error.attempt.secondaryExerciseId
			),
			sessionId: `exercise-merge:${error.attempt.mainExerciseId}:${error.attempt.secondaryExerciseId}`,
			payload: error.attempt
		});
	} catch (durabilityError) {
		markExerciseMergeCompensationNonDurable(error, durabilityError);
	}
}

function removeExerciseMergeCompensationJournal(error: ExerciseMergeCompensationError) {
	if (!error.journalEntry) {
		return;
	}

	try {
		removeCompensationJournalEntry(error.journalEntry);
		error.journalEntry = null;
	} catch (durabilityError) {
		error.cleanupErrors.push(durabilityError);
	}
}

async function getExerciseMergeMutationRow(
	database: AuthenticatedOperationDatabase,
	mutation: ExerciseMergeMutation
) {
	switch (mutation.table) {
		case 'exercises':
			return database.exercises.get(mutation.after.id);
		case 'sessionExercises':
			return database.sessionExercises.get(mutation.after.id);
		case 'sessionSets':
			return database.sessionSets.get(mutation.after.id);
		case 'workoutSessions':
			return database.workoutSessions.get(mutation.after.id);
	}
}

async function exerciseMergeMutationNeedsRepair(
	database: AuthenticatedOperationDatabase,
	mutation: ExerciseMergeMutation
) {
	const current = await getExerciseMergeMutationRow(database, mutation);
	return Boolean(current && rowsExactlyMatch(current, mutation.after));
}

async function restoreExerciseMergeMutation(
	database: AuthenticatedOperationDatabase,
	mutation: ExerciseMergeMutation
) {
	switch (mutation.table) {
		case 'exercises':
			if (mutation.before) {
				await database.exercises.put(mutation.before);
			} else {
				await database.exercises.delete(mutation.after.id);
			}
			return;
		case 'sessionExercises':
			if (mutation.before) {
				await database.sessionExercises.put(mutation.before);
			} else {
				await database.sessionExercises.delete(mutation.after.id);
			}
			return;
		case 'sessionSets':
			if (mutation.before) {
				await database.sessionSets.put(mutation.before);
			} else {
				await database.sessionSets.delete(mutation.after.id);
			}
			return;
		case 'workoutSessions':
			if (mutation.before) {
				await database.workoutSessions.put(mutation.before);
			} else {
				await database.workoutSessions.delete(mutation.after.id);
			}
	}
}

async function compensateFailedExerciseMerge(
	database: AuthenticatedOperationDatabase,
	attempt: ExerciseMergeCompensationAttempt
): Promise<ExerciseMergeCompensationReport> {
	const cleanupErrors: unknown[] = [];

	for (const mutation of [...attempt.mutations].reverse()) {
		try {
			if (await exerciseMergeMutationNeedsRepair(database, mutation)) {
				await restoreExerciseMergeMutation(database, mutation);
			}
		} catch (error) {
			cleanupErrors.push(
				new Error(`Failed to restore ${getExerciseMergeMutationKey(mutation)}.`, {
					cause: error
				})
			);
		}
	}

	const remainingRowIds: string[] = [];

	for (const mutation of attempt.mutations) {
		try {
			if (await exerciseMergeMutationNeedsRepair(database, mutation)) {
				remainingRowIds.push(getExerciseMergeMutationKey(mutation));
			}
		} catch (error) {
			remainingRowIds.push(getExerciseMergeMutationKey(mutation));
			cleanupErrors.push(
				new Error(`Failed to verify restored ${getExerciseMergeMutationKey(mutation)}.`, {
					cause: error
				})
			);
		}
	}

	return { cleanupErrors, remainingRowIds: [...new Set(remainingRowIds)] };
}

function requireExerciseMergeCompensationOwner(
	operation: Pick<AuthenticatedDatabaseOperation, 'userId'>,
	attempt: ExerciseMergeCompensationAttempt
) {
	if (operation.userId !== attempt.userId) {
		throw new Error('Pending exercise merge compensation belongs to a different user.');
	}
}

async function repairExerciseMergeCompensationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	error: ExerciseMergeCompensationError
) {
	requireExerciseMergeCompensationOwner(operation, error.attempt);
	const report = await compensateFailedExerciseMerge(operation.database, error.attempt);
	error.cleanupErrors.push(...report.cleanupErrors);
	error.remainingRowIds = report.remainingRowIds;

	if (error.remainingRowIds.length === 0) {
		removeExerciseMergeCompensationJournal(error);
		const scopeKey = getExerciseMergeScopeKey(
			error.attempt.userId,
			error.attempt.mainExerciseId,
			error.attempt.secondaryExerciseId
		);
		const pending = pendingExerciseMergeCompensations.get(scopeKey);
		pending?.delete(error);

		if (pending?.size === 0) {
			pendingExerciseMergeCompensations.delete(scopeKey);
		}
	}

	return error.remainingRowIds.length === 0;
}

export async function repairExerciseMergeCompensation(error: ExerciseMergeCompensationError) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		repairExerciseMergeCompensationWithOperation(operation, error)
	);
}

async function repairPendingExerciseMergeCompensations(
	operation: AuthenticatedDatabaseOperation,
	mainExerciseId: string,
	secondaryExerciseId: string
) {
	const scopeKey = getExerciseMergeScopeKey(operation.userId, mainExerciseId, secondaryExerciseId);
	let pending = pendingExerciseMergeCompensations.get(scopeKey);

	if (!pending) {
		try {
			const hydratedErrors = readCompensationJournalEntries({
				userId: operation.userId,
				kind: 'exercise-merge',
				operationKey: scopeKey,
				validatePayload: isExerciseMergeCompensationAttempt
			}).flatMap((entry) => {
				if (
					entry.payload.userId !== operation.userId ||
					entry.payload.mainExerciseId !== mainExerciseId ||
					entry.payload.secondaryExerciseId !== secondaryExerciseId
				) {
					return [];
				}

				const error = new ExerciseMergeCompensationError(
					new Error('Recovered an interrupted exercise merge repair from durable storage.'),
					[],
					entry.payload.mutations.map(getExerciseMergeMutationKey),
					entry.payload
				);
				error.journalEntry = entry;
				return [error];
			});

			if (hydratedErrors.length > 0) {
				pending = new Set(hydratedErrors);
				pendingExerciseMergeCompensations.set(scopeKey, pending);
			}
		} catch {
			// A subsequent incomplete repair will surface an explicit non-durable warning.
		}
	}

	if (!pending) {
		return;
	}

	for (const error of [...pending]) {
		await repairExerciseMergeCompensationWithOperation(operation, error);
	}

	const stillPending = pendingExerciseMergeCompensations.get(scopeKey);

	if (stillPending && stillPending.size > 0) {
		throw stillPending.values().next().value;
	}
}

function trackIncompleteExerciseMerge(error: ExerciseMergeCompensationError) {
	persistExerciseMergeCompensation(error);
	const scopeKey = getExerciseMergeScopeKey(
		error.attempt.userId,
		error.attempt.mainExerciseId,
		error.attempt.secondaryExerciseId
	);
	const pending = pendingExerciseMergeCompensations.get(scopeKey) ?? new Set();
	pending.add(error);
	pendingExerciseMergeCompensations.set(scopeKey, pending);
}

async function throwAfterExerciseMergeCompensation(
	database: AuthenticatedOperationDatabase,
	originalError: unknown,
	attempt: ExerciseMergeCompensationAttempt
): Promise<never> {
	const report = await compensateFailedExerciseMerge(database, attempt);

	if (report.cleanupErrors.length > 0 || report.remainingRowIds.length > 0) {
		const error = new ExerciseMergeCompensationError(
			originalError,
			report.cleanupErrors,
			report.remainingRowIds,
			attempt
		);
		trackIncompleteExerciseMerge(error);
		throw error;
	}

	throw originalError;
}

async function planCustomExerciseRename(
	exercise: Exercise,
	nextName: string,
	now: string,
	database: Pick<AuthenticatedOperationDatabase, 'exercises'>
): Promise<{ exercise: Exercise; renamed: boolean }> {
	const cleanName = displayName(nextName);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	if (BASELINE_EXERCISE_BY_ID.has(exercise.id) || exercise.source !== 'custom') {
		return { exercise, renamed: false };
	}

	if (normalizedName === exercise.normalizedName && cleanName === exercise.name) {
		return { exercise, renamed: false };
	}

	const matchingExercises = (
		await database.exercises.where('normalizedName').equals(normalizedName).toArray()
	)
		.map(withExerciseDefaults)
		.filter((candidate) => candidate.id !== exercise.id && !candidate.archived);

	if (
		matchingExercises.length > 0 ||
		(BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(normalizedName) &&
			BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(normalizedName)?.id !== exercise.id)
	) {
		throw new Error('That exercise name is already in use.');
	}

	const nextExercise = {
		...exercise,
		name: cleanName,
		normalizedName,
		updatedAt: now
	};

	return { exercise: nextExercise, renamed: true };
}

export async function renameCustomExercise(
	exercise: Exercise,
	nextName: string,
	now = timestamp(),
	database: Pick<AuthenticatedOperationDatabase, 'exercises'> = db
): Promise<{ exercise: Exercise; renamed: boolean }> {
	const result = await planCustomExerciseRename(exercise, nextName, now, database);

	if (!result.renamed) {
		return result;
	}

	const updated = await database.exercises.update(exercise.id, {
		name: result.exercise.name,
		normalizedName: result.exercise.normalizedName,
		updatedAt: result.exercise.updatedAt
	});

	if (updated !== 1) {
		throw new Error('Main exercise disappeared while it was being renamed.');
	}

	return result;
}

export async function mergeExerciseHistory(
	input: ExerciseMergeInput
): Promise<ExerciseMergeResult> {
	requireLoggedInUser();

	if (input.mainExerciseId === input.secondaryExerciseId) {
		throw new Error('Choose two different exercises to merge.');
	}

	const mergeResult = await runAuthenticatedDatabaseOperation(async (operation) => {
		const { database, userId } = operation;
		await repairPendingExerciseMergeCompensations(
			operation,
			input.mainExerciseId,
			input.secondaryExerciseId
		);

		const [mainExercise, secondaryExercise] = await Promise.all([
			getExercise(input.mainExerciseId, database),
			getExercise(input.secondaryExerciseId, database)
		]);

		if (!mainExercise) {
			throw new Error('Main exercise not found.');
		}

		if (!secondaryExercise) {
			throw new Error('Secondary exercise not found.');
		}

		const now = timestamp();
		const secondarySessionExercises = await database.sessionExercises
			.where('exerciseId')
			.equals(secondaryExercise.id)
			.toArray();
		const secondarySessionExerciseIds = secondarySessionExercises.map(
			(sessionExercise) => sessionExercise.id
		);
		const storedSecondarySessionSets =
			secondarySessionExerciseIds.length === 0
				? []
				: await database.sessionSets
						.where('sessionExerciseId')
						.anyOf(secondarySessionExerciseIds)
						.toArray();
		const secondarySessionSets = filterSessionSetsForSessionExercises(
			storedSecondarySessionSets,
			secondarySessionExercises
		).map(withSessionSetDefaults);
		const setsBySessionExerciseId = new Map<string, SessionSet[]>();

		for (const sessionSet of secondarySessionSets) {
			const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
			rows.push(sessionSet);
			setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
		}

		const copyGroups: ExerciseMergeCopyGroup[] = secondarySessionExercises.flatMap(
			(secondarySessionExercise) => {
				const sourceSets = setsBySessionExerciseId.get(secondarySessionExercise.id) ?? [];

				if (!hasPerformedSetValues(sourceSets)) {
					return [];
				}

				return [
					{
						secondarySessionExercise,
						sourceSets,
						copiedSessionExerciseId: getMergedSessionExerciseId(
							mainExercise.id,
							secondarySessionExercise.id
						)
					}
				];
			}
		);
		const attempt: ExerciseMergeCompensationAttempt = {
			userId,
			mainExerciseId: mainExercise.id,
			secondaryExerciseId: secondaryExercise.id,
			mutations: []
		};
		let renamedMainExercise = mainExercise;
		let renamed = false;
		let copiedSessionExercises = 0;
		let copiedSessionSets = 0;
		let skippedConflicts = 0;

		try {
			await database.transaction(
				'rw',
				database.exercises,
				database.workoutSessions,
				database.sessionExercises,
				database.sessionSets,
				async () => {
					const [currentMainExercise, currentSecondaryExercise] = await Promise.all([
						getExercise(mainExercise.id, database),
						getExercise(secondaryExercise.id, database)
					]);

					if (!currentMainExercise) {
						throw new Error('Main exercise not found.');
					}

					if (!currentSecondaryExercise) {
						throw new Error('Secondary exercise not found.');
					}

					renamedMainExercise = currentMainExercise;

					if (input.mainExerciseName !== undefined) {
						const renameResult = await planCustomExerciseRename(
							currentMainExercise,
							input.mainExerciseName,
							now,
							database
						);

						if (renameResult.renamed) {
							attempt.mutations.push({
								table: 'exercises',
								before: currentMainExercise,
								after: renameResult.exercise
							});
							const updated = await database.exercises.update(currentMainExercise.id, {
								name: renameResult.exercise.name,
								normalizedName: renameResult.exercise.normalizedName,
								updatedAt: renameResult.exercise.updatedAt
							});

							if (updated !== 1) {
								throw new Error('Main exercise disappeared while it was being renamed.');
							}
						}

						renamedMainExercise = renameResult.exercise;
						renamed = renameResult.renamed;
					}

					const intendedCopiedIds = new Set(
						copyGroups.map((group) => group.copiedSessionExerciseId)
					);
					const currentMainRows = await database.sessionExercises
						.where('exerciseId')
						.equals(mainExercise.id)
						.toArray();
					const claimedSessionIds = new Map<string, string>();

					for (const row of currentMainRows.filter((row) => !intendedCopiedIds.has(row.id))) {
						claimedSessionIds.set(row.sessionId, row.id);
					}

					for (const row of currentMainRows.filter((row) => intendedCopiedIds.has(row.id))) {
						if (!claimedSessionIds.has(row.sessionId)) {
							claimedSessionIds.set(row.sessionId, row.id);
						}
					}

					const touchedSessions = new Map<string, WorkoutSession>();

					for (const group of copyGroups) {
						const { secondarySessionExercise, copiedSessionExerciseId, sourceSets } = group;
						const sourceSession = await database.workoutSessions.get(
							secondarySessionExercise.sessionId
						);

						if (!sourceSession) {
							skippedConflicts += 1;
							continue;
						}

						let copiedSessionExercise =
							await database.sessionExercises.get(copiedSessionExerciseId);
						const claimedRowId = claimedSessionIds.get(secondarySessionExercise.sessionId);

						if (claimedRowId && claimedRowId !== copiedSessionExerciseId) {
							skippedConflicts += 1;
							continue;
						}

						if (
							copiedSessionExercise &&
							(copiedSessionExercise.sessionId !== secondarySessionExercise.sessionId ||
								copiedSessionExercise.workoutId !== secondarySessionExercise.workoutId ||
								copiedSessionExercise.exerciseId !== mainExercise.id)
						) {
							skippedConflicts += 1;
							continue;
						}

						let wroteGroupRow = false;

						if (!copiedSessionExercise) {
							const nextSessionExercise: SessionExercise = {
								...secondarySessionExercise,
								id: copiedSessionExerciseId,
								exerciseId: mainExercise.id,
								exerciseNameSnapshot: renamedMainExercise.name,
								createdAt: now,
								updatedAt: now
							};
							const syncState =
								await database.sessionExercises.getSyncState(copiedSessionExerciseId);

							if (syncState && !syncState.deleted) {
								skippedConflicts += 1;
								continue;
							}

							attempt.mutations.push({
								table: 'sessionExercises',
								before: undefined,
								after: nextSessionExercise
							});

							if (syncState?.deleted) {
								await database.sessionExercises.put(nextSessionExercise);
							} else {
								await database.sessionExercises.add(nextSessionExercise);
							}

							copiedSessionExercise = nextSessionExercise;
							copiedSessionExercises += 1;
							wroteGroupRow = true;
						} else {
							skippedConflicts += 1;
						}

						claimedSessionIds.set(secondarySessionExercise.sessionId, copiedSessionExercise.id);

						for (const sourceSet of sourceSets) {
							const copiedSessionSetId = getMergedSessionSetId(
								copiedSessionExerciseId,
								sourceSet.id
							);
							const existingSet = await database.sessionSets.get(copiedSessionSetId);

							if (existingSet) {
								continue;
							}

							const copiedSessionSet: SessionSet = {
								...sourceSet,
								id: copiedSessionSetId,
								sessionExerciseId: copiedSessionExerciseId,
								exerciseId: mainExercise.id,
								createdAt: now,
								updatedAt: now
							};
							const syncState = await database.sessionSets.getSyncState(copiedSessionSetId);

							if (syncState && !syncState.deleted) {
								continue;
							}

							attempt.mutations.push({
								table: 'sessionSets',
								before: undefined,
								after: copiedSessionSet
							});

							if (syncState?.deleted) {
								await database.sessionSets.put(copiedSessionSet);
							} else {
								await database.sessionSets.add(copiedSessionSet);
							}

							copiedSessionSets += 1;
							wroteGroupRow = true;
						}

						if (wroteGroupRow) {
							touchedSessions.set(sourceSession.id, sourceSession);
						}
					}

					for (const [sessionId, prefetchedSession] of touchedSessions) {
						const currentSession = await database.workoutSessions.get(sessionId);

						if (!currentSession) {
							throw new Error('A copied history session disappeared during the merge.');
						}

						const before = rowsExactlyMatch(currentSession, prefetchedSession)
							? prefetchedSession
							: currentSession;
						const after = { ...before, updatedAt: now };

						if (rowsExactlyMatch(before, after)) {
							continue;
						}

						attempt.mutations.push({ table: 'workoutSessions', before, after });
						const updated = await database.workoutSessions.update(sessionId, { updatedAt: now });

						if (updated !== 1) {
							throw new Error('A copied history session disappeared during metadata update.');
						}
					}

					for (const mutation of attempt.mutations) {
						const stored = await getExerciseMergeMutationRow(database, mutation);

						if (!stored || !rowsExactlyMatch(stored, mutation.after)) {
							throw new Error(
								`Exercise merge verification failed for ${getExerciseMergeMutationKey(mutation)}.`
							);
						}
					}
				}
			);
		} catch (error) {
			return throwAfterExerciseMergeCompensation(database, error, attempt);
		}

		return {
			mainExercise: renamedMainExercise,
			secondaryExercise,
			copiedSessionExercises,
			copiedSessionSets,
			skippedConflicts,
			renamed
		};
	});

	try {
		await syncNow();
		return { ...mergeResult, syncStatus: 'synced' };
	} catch (error) {
		return {
			...mergeResult,
			syncStatus: 'failed',
			syncError: error instanceof Error ? error.message : 'Sync failed.'
		};
	}
}
