import { SESSION_INACTIVITY_ABANDON_MS } from '../../session-inactivity';
import {
	getCompensationJournalDurabilityMessage,
	persistCompensationJournalEntry,
	readCompensationJournalEntries,
	removeCompensationJournalEntry,
	type CompensationJournalEntry
} from '../compensation-journal';
import type {
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from '../models';
import {
	canAttemptSessionCleanup,
	confirmSessionCleanupIsFresh,
	ensureDbOpen,
	getActiveCloudUser,
	markStaleSessionCleanupCompleted,
	requireLoggedInUser,
	runAuthenticatedDatabaseOperation,
	syncNow,
	type AuthenticatedDatabaseOperation,
	type AuthenticatedOperationDatabase,
	type DataTable,
	wasStaleSessionCleanupCompleted
} from '../runtime';
import {
	createId,
	getSessionActivityAt,
	reconcileSessionExerciseOrderCollisions,
	summarizeSession,
	timestamp,
	toDayKey,
	type SessionActivityTimestamp
} from '../shared';
import { listWorkoutExercises } from '../workouts';
import { getSessionOverviewWithDatabase, listSessionExerciseDetailsWithDatabase } from './data';
import { flushSessionInputDraftWithDatabase } from './inputs';
import { buildSessionResumeTiming, getResumedSessionExercisePerformedAt } from './resume';
import {
	getScheduledSessionExerciseId,
	getScheduledSessionSetLogicalId,
	getScheduledWorkoutSessionId
} from './schedule-identity';
import { repairScheduledSessionDay } from './schedule-integrity';
import { buildSessionSeedSetRows, ensureEditableSessionSeedRows } from './seeding';

type SessionLifecycleDatabase = AuthenticatedOperationDatabase;

async function getStoredSessionActivityAtForDatabase(
	database: Pick<SessionLifecycleDatabase, 'sessionExercises' | 'sessionSets'>,
	session: WorkoutSession
) {
	const sessionExercises = await database.sessionExercises
		.where('sessionId')
		.equals(session.id)
		.toArray();
	const sessionExerciseIds = sessionExercises.map(({ id }) => id);
	const storedSessionSets =
		sessionExerciseIds.length === 0
			? []
			: await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();
	const visibleSessionExerciseIds = new Set(
		sessionExercises
			.filter(
				(sessionExercise) =>
					sessionExercise.sessionId === session.id &&
					sessionExercise.workoutId === session.workoutId
			)
			.map(({ id }) => id)
	);
	const sessionSets = storedSessionSets.filter((sessionSet) =>
		visibleSessionExerciseIds.has(sessionSet.sessionExerciseId)
	);

	return getSessionActivityAt(session, sessionSets);
}

export async function getStoredSessionActivityAt(session: WorkoutSession) {
	return runAuthenticatedDatabaseOperation(({ database }) =>
		getStoredSessionActivityAtForDatabase(database, session)
	);
}

export function isSessionInactive(
	session: WorkoutSession,
	activityAt: SessionActivityTimestamp | null,
	nowMs = Date.now()
) {
	return (
		session.status === 'in_progress' &&
		Boolean(activityAt && nowMs - activityAt.time >= SESSION_INACTIVITY_ABANDON_MS)
	);
}

async function abandonStoredInactiveSessionForOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string,
	nowMs: number
) {
	const { database } = operation;
	return database.transaction(
		'rw',
		database.workoutSessions,
		database.sessionExercises,
		database.sessionSets,
		async () => {
			const session = await database.workoutSessions.get(sessionId);

			if (!session || session.status !== 'in_progress') {
				return false;
			}

			const activityAt = await getStoredSessionActivityAtForDatabase(database, session);

			if (!activityAt || !isSessionInactive(session, activityAt, nowMs)) {
				return false;
			}

			const updated = await database.workoutSessions.update(session.id, {
				status: 'abandoned',
				completedAt: activityAt.value,
				updatedAt: timestamp()
			});

			if (updated !== 1) {
				throw new Error('The session disappeared while it was being abandoned.');
			}
			return true;
		}
	);
}

export async function abandonStoredInactiveSession(sessionId: string, nowMs: number) {
	return runAuthenticatedDatabaseOperation((operation) =>
		abandonStoredInactiveSessionForOperation(operation, sessionId, nowMs)
	);
}

async function abandonInactiveWorkoutSessionForOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string,
	nowMs: number
) {
	const { database, userId } = operation;

	if (!canAttemptSessionCleanup()) {
		return false;
	}

	await flushSessionInputDraftWithDatabase(database, sessionId, { clearDraft: false }, userId);
	const currentSession = await database.workoutSessions.get(sessionId);
	const currentActivityAt = currentSession
		? await getStoredSessionActivityAtForDatabase(database, currentSession)
		: null;

	if (!currentSession || !isSessionInactive(currentSession, currentActivityAt, nowMs)) {
		return false;
	}

	if (!(await confirmSessionCleanupIsFresh())) {
		return false;
	}

	await flushSessionInputDraftWithDatabase(database, sessionId, {}, userId);
	const abandoned = await abandonStoredInactiveSessionForOperation(operation, sessionId, nowMs);

	if (!abandoned) {
		return false;
	}

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});

	return true;
}

export async function abandonInactiveWorkoutSession(sessionId: string, nowMs = Date.now()) {
	requireLoggedInUser();
	const expectedUserId = getActiveCloudUser().userId;
	await ensureDbOpen();
	return runAuthenticatedDatabaseOperation((operation) => {
		if (!expectedUserId || operation.userId !== expectedUserId) {
			throw new Error('The signed-in user changed before the session could be checked.');
		}

		return abandonInactiveWorkoutSessionForOperation(operation, sessionId, nowMs);
	});
}

async function cleanupStaleSessionsForOperation(
	operation: AuthenticatedDatabaseOperation,
	todayDayKey: string
) {
	const { database, userId } = operation;

	if (!canAttemptSessionCleanup()) {
		return;
	}

	const nowMs = Date.now();
	const cleanupKey = `${userId}:${todayDayKey}:${Math.floor(nowMs / 60_000)}`;

	if (wasStaleSessionCleanupCompleted(cleanupKey)) {
		return;
	}

	let runningSessions = await database.workoutSessions
		.where('status')
		.equals('in_progress')
		.toArray();

	for (const runningSession of runningSessions) {
		await flushSessionInputDraftWithDatabase(
			database,
			runningSession.id,
			{ clearDraft: false },
			userId
		);
	}

	const hasStaleRunningSession = (
		await Promise.all(
			runningSessions.map(async (session) => {
				const activityAt = await getStoredSessionActivityAtForDatabase(database, session);
				return isSessionInactive(session, activityAt, nowMs);
			})
		)
	).some(Boolean);

	if (!hasStaleRunningSession) {
		markStaleSessionCleanupCompleted(cleanupKey);
		return;
	}

	if (!(await confirmSessionCleanupIsFresh())) {
		return;
	}

	runningSessions = await database.workoutSessions.where('status').equals('in_progress').toArray();

	for (const runningSession of runningSessions) {
		await flushSessionInputDraftWithDatabase(database, runningSession.id, {}, userId);
	}

	for (const runningSession of runningSessions) {
		await abandonStoredInactiveSessionForOperation(operation, runningSession.id, nowMs);
	}

	markStaleSessionCleanupCompleted(cleanupKey);
}

export async function cleanupStaleSessions(todayDayKey = toDayKey(new Date())) {
	await ensureDbOpen();
	const activeUser = getActiveCloudUser();

	if (!activeUser.isLoggedIn || !activeUser.userId) {
		return;
	}

	return runAuthenticatedDatabaseOperation((operation) =>
		cleanupStaleSessionsForOperation(operation, todayDayKey)
	);
}

function scheduledRowStillMatches<T extends { id: string }>(stored: T, expected: T) {
	return Object.entries(expected).every(
		([key, value]) => (stored as unknown as Record<string, unknown>)[key] === value
	);
}

export type ScheduledSessionCreationAttempt = {
	userId: string;
	session: WorkoutSession;
	sessionExercises: SessionExercise[];
	sessionSets: SessionSet[];
	workout: Workout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredRow(
	value: unknown
): value is Record<string, unknown> & { id: string; createdAt: string } {
	return isRecord(value) && typeof value.id === 'string' && typeof value.createdAt === 'string';
}

function isScheduledSessionCreationAttempt(
	value: unknown
): value is ScheduledSessionCreationAttempt {
	if (
		!isRecord(value) ||
		typeof value.userId !== 'string' ||
		!isRecord(value.session) ||
		!isStoredRow(value.session) ||
		typeof value.session.dayKey !== 'string' ||
		typeof value.session.workoutId !== 'string' ||
		!Array.isArray(value.sessionExercises) ||
		!Array.isArray(value.sessionSets) ||
		!isRecord(value.workout) ||
		!isStoredRow(value.workout)
	) {
		return false;
	}

	const session = value.session;
	const sessionExercises = value.sessionExercises;
	const sessionExerciseIds = new Set<string>();

	for (const row of sessionExercises) {
		if (
			!isRecord(row) ||
			!isStoredRow(row) ||
			row.sessionId !== session.id ||
			row.workoutId !== session.workoutId
		) {
			return false;
		}

		sessionExerciseIds.add(row.id);
	}

	for (const row of value.sessionSets) {
		if (
			!isRecord(row) ||
			!isStoredRow(row) ||
			typeof row.sessionExerciseId !== 'string' ||
			!sessionExerciseIds.has(row.sessionExerciseId)
		) {
			return false;
		}
	}

	if (value.workout.id !== session.workoutId) {
		return false;
	}

	return true;
}

type ScheduledSessionCompensationReport = {
	cleanupErrors: unknown[];
	remainingRowIds: string[];
};

const pendingScheduledSessionCompensations = new Map<string, ScheduledSessionCompensationError>();

function getScheduledSessionCompensationKey(userId: string, dayKey: string) {
	return `${userId}:${dayKey}`;
}

export class ScheduledSessionCompensationError extends Error {
	readonly cleanupErrors: unknown[];
	remainingRowIds: string[];
	journalEntry: CompensationJournalEntry<ScheduledSessionCreationAttempt> | null = null;
	readonly durabilityErrors: unknown[] = [];

	constructor(
		readonly originalError: unknown,
		cleanupErrors: unknown[],
		remainingRowIds: string[],
		readonly attempt: ScheduledSessionCreationAttempt
	) {
		super(
			'Scheduling failed and TinyTrain could not fully remove the incomplete session. Retry scheduling so the remaining temporary data can be repaired.',
			{ cause: originalError }
		);
		this.name = 'ScheduledSessionCompensationError';
		this.cleanupErrors = [...cleanupErrors];
		this.remainingRowIds = [...remainingRowIds];
	}
}

function markScheduledCompensationNonDurable(
	error: ScheduledSessionCompensationError,
	durabilityError: unknown
) {
	error.durabilityErrors.push(durabilityError);

	if (!error.message.includes('Recovery could not be saved for reload safety.')) {
		error.message += getCompensationJournalDurabilityMessage(durabilityError);
	}
}

function persistScheduledSessionCompensation(error: ScheduledSessionCompensationError) {
	if (error.journalEntry) {
		return;
	}

	try {
		error.journalEntry = persistCompensationJournalEntry({
			kind: 'scheduled-session',
			userId: error.attempt.userId,
			operationKey: getScheduledSessionCompensationKey(
				error.attempt.userId,
				error.attempt.session.dayKey
			),
			sessionId: error.attempt.session.id,
			payload: error.attempt
		});
	} catch (durabilityError) {
		markScheduledCompensationNonDurable(error, durabilityError);
	}
}

function removeScheduledSessionCompensationJournal(error: ScheduledSessionCompensationError) {
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

function hydrateScheduledSessionCompensations(userId: string, operationKey: string) {
	let entries: CompensationJournalEntry<ScheduledSessionCreationAttempt>[];

	try {
		entries = readCompensationJournalEntries({
			userId,
			kind: 'scheduled-session',
			operationKey,
			validatePayload: isScheduledSessionCreationAttempt
		});
	} catch {
		// A new failure will surface inability to write the journal. Existing in-memory repair state
		// remains usable when optional browser storage is temporarily inaccessible.
		return [];
	}

	return entries.flatMap((entry) => {
		if (entry.payload.userId !== userId) {
			return [];
		}

		const error = new ScheduledSessionCompensationError(
			new Error('Recovered an interrupted scheduling repair from durable storage.'),
			[],
			[
				entry.payload.session.id,
				...entry.payload.sessionExercises.map(({ id }) => id),
				...entry.payload.sessionSets.map(({ id }) => id)
			],
			entry.payload
		);
		error.journalEntry = entry;
		return [error];
	});
}

async function findOwnedScheduledSessionRows(
	database: Pick<SessionLifecycleDatabase, 'workoutSessions' | 'sessionExercises' | 'sessionSets'>,
	session: WorkoutSession,
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[]
) {
	const [storedSession, storedSessionExercises, storedSessionSets] = await Promise.all([
		database.workoutSessions.get(session.id),
		database.sessionExercises.bulkGet(
			sessionExercises.map((sessionExercise) => sessionExercise.id)
		),
		database.sessionSets.bulkGet(sessionSets.map((sessionSet) => sessionSet.id))
	]);

	return [
		...(storedSession && scheduledRowStillMatches(storedSession, session)
			? [storedSession.id]
			: []),
		...storedSessionExercises.flatMap((storedRow, index) =>
			storedRow && scheduledRowStillMatches(storedRow, sessionExercises[index])
				? [storedRow.id]
				: []
		),
		...storedSessionSets.flatMap((storedRow, index) =>
			storedRow && scheduledRowStillMatches(storedRow, sessionSets[index]) ? [storedRow.id] : []
		)
	];
}

async function compensateFailedScheduledSessionCreation(
	database: Pick<
		SessionLifecycleDatabase,
		'workoutSessions' | 'sessionExercises' | 'sessionSets' | 'workouts'
	>,
	session: WorkoutSession,
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[],
	workout: Workout
): Promise<ScheduledSessionCompensationReport> {
	const cleanupErrors: unknown[] = [];

	async function attemptCleanup(label: string, callback: () => Promise<unknown>) {
		try {
			await callback();
		} catch (error) {
			cleanupErrors.push(new Error(label, { cause: error }));
		}
	}

	await attemptCleanup('Failed to remove incomplete scheduled sets.', async () => {
		const storedRows = await database.sessionSets.bulkGet(
			sessionSets.map((sessionSet) => sessionSet.id)
		);
		const ownedIds = storedRows.flatMap((storedRow, index) =>
			storedRow && scheduledRowStillMatches(storedRow, sessionSets[index]) ? [storedRow.id] : []
		);

		if (ownedIds.length > 0) {
			await database.sessionSets.bulkDelete(ownedIds);
		}
	});
	await attemptCleanup('Failed to remove incomplete scheduled exercises.', async () => {
		const storedRows = await database.sessionExercises.bulkGet(
			sessionExercises.map((sessionExercise) => sessionExercise.id)
		);
		const ownedIds = storedRows.flatMap((storedRow, index) =>
			storedRow && scheduledRowStillMatches(storedRow, sessionExercises[index])
				? [storedRow.id]
				: []
		);

		if (ownedIds.length > 0) {
			await database.sessionExercises.bulkDelete(ownedIds);
		}
	});
	await attemptCleanup('Failed to remove the incomplete scheduled session.', async () => {
		const storedSession = await database.workoutSessions.get(session.id);

		if (storedSession && scheduledRowStillMatches(storedSession, session)) {
			await database.workoutSessions.delete(session.id);
		}
	});
	await attemptCleanup('Failed to restore workout metadata after scheduling failed.', async () => {
		const storedWorkout = await database.workouts.get(workout.id);

		if (storedWorkout?.updatedAt === session.createdAt && workout.updatedAt !== session.createdAt) {
			await database.workouts.update(workout.id, { updatedAt: workout.updatedAt });
		}
	});

	let remainingRowIds = [...sessionSets, ...sessionExercises, session].map((row) => row.id);

	try {
		remainingRowIds = await findOwnedScheduledSessionRows(
			database,
			session,
			sessionExercises,
			sessionSets
		);
	} catch (error) {
		cleanupErrors.push(
			new Error('Failed to verify that incomplete scheduled rows were removed.', { cause: error })
		);
	}

	return { cleanupErrors, remainingRowIds };
}

async function repairScheduledSessionCompensationForOperation(
	operation: AuthenticatedDatabaseOperation,
	error: ScheduledSessionCompensationError
) {
	const { attempt } = error;

	if (operation.userId !== attempt.userId) {
		throw new Error('Cannot repair a scheduled session created by a different signed-in user.');
	}

	const report = await compensateFailedScheduledSessionCreation(
		operation.database,
		attempt.session,
		attempt.sessionExercises,
		attempt.sessionSets,
		attempt.workout
	);
	error.cleanupErrors.push(...report.cleanupErrors);
	error.remainingRowIds = report.remainingRowIds;

	if (report.remainingRowIds.length === 0) {
		try {
			await repairScheduledSessionDay(operation.database, attempt.userId, attempt.session.dayKey);
		} catch (repairError) {
			error.cleanupErrors.push(
				new Error('Failed to reconcile the session day after compensation.', {
					cause: repairError
				})
			);
		}
	}

	if (error.remainingRowIds.length === 0) {
		removeScheduledSessionCompensationJournal(error);
		const key = getScheduledSessionCompensationKey(
			error.attempt.userId,
			error.attempt.session.dayKey
		);

		if (pendingScheduledSessionCompensations.get(key) === error) {
			pendingScheduledSessionCompensations.delete(key);
		}
	}

	return error.remainingRowIds.length === 0;
}

export async function repairScheduledSessionCompensation(error: ScheduledSessionCompensationError) {
	return runAuthenticatedDatabaseOperation((operation) =>
		repairScheduledSessionCompensationForOperation(operation, error)
	);
}

type ScheduledRowWritePlan<T> = {
	absentRows: T[];
	tombstonedRows: T[];
};

async function planScheduledRowWrites<T extends { id: string }>(
	table: Pick<DataTable<T>, 'getSyncState'>,
	rows: T[],
	liveConflictMessage: string
): Promise<ScheduledRowWritePlan<T>> {
	const states = await Promise.all(rows.map((row) => table.getSyncState(row.id)));
	const liveRowIndex = states.findIndex((state) => state && !state.deleted);

	if (liveRowIndex >= 0) {
		throw new Error(liveConflictMessage);
	}

	return {
		absentRows: rows.filter((_, index) => states[index] === undefined),
		tombstonedRows: rows.filter((_, index) => states[index]?.deleted === true)
	};
}

async function writeScheduledRows<T extends { id: string }>(
	table: Pick<DataTable<T>, 'bulkAdd' | 'bulkPut'>,
	plan: ScheduledRowWritePlan<T>
) {
	if (plan.absentRows.length > 0) {
		await table.bulkAdd(plan.absentRows);
	}

	if (plan.tombstonedRows.length > 0) {
		await table.bulkPut(plan.tombstonedRows);
	}
}

export async function scheduleWorkoutSession(workoutId: string, dayKey: string) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		const { database, userId } = operation;
		const todayDayKey = toDayKey(new Date());

		if (dayKey !== todayDayKey) {
			throw new Error('You can only schedule a workout for today.');
		}

		const compensationKey = getScheduledSessionCompensationKey(userId, dayKey);
		let pendingCompensation = pendingScheduledSessionCompensations.get(compensationKey);

		if (!pendingCompensation) {
			for (const hydratedCompensation of hydrateScheduledSessionCompensations(
				userId,
				compensationKey
			)) {
				if (
					!(await repairScheduledSessionCompensationForOperation(operation, hydratedCompensation))
				) {
					pendingCompensation = hydratedCompensation;
					pendingScheduledSessionCompensations.set(compensationKey, hydratedCompensation);
					break;
				}
			}
		}

		if (
			pendingCompensation &&
			!(await repairScheduledSessionCompensationForOperation(operation, pendingCompensation))
		) {
			throw pendingCompensation;
		}

		await cleanupStaleSessionsForOperation(operation, todayDayKey);
		await repairScheduledSessionDay(database, userId, dayKey);

		const existingSession = (
			await database.workoutSessions.where('dayKey').equals(dayKey).toArray()
		).find(
			(session) =>
				session.status === 'planned' ||
				session.status === 'in_progress' ||
				session.status === 'completed' ||
				session.status === 'abandoned'
		);

		if (existingSession) {
			throw new Error('A session already exists for today.');
		}

		const workout = await database.workouts.get(workoutId);

		if (!workout || workout.archived) {
			throw new Error('Workout not found.');
		}

		const workoutExercises = await listWorkoutExercises(workoutId, database);
		const createdAt = timestamp();
		const session: WorkoutSession = {
			id: getScheduledWorkoutSessionId(userId, dayKey),
			workoutId,
			workoutNameSnapshot: workout.name,
			dayKey,
			status: 'planned',
			createdAt,
			updatedAt: createdAt
		};
		const sessionExercises: SessionExercise[] = workoutExercises.map((workoutExercise, index) => ({
			id: getScheduledSessionExerciseId(
				session.id,
				workoutId,
				workoutExercise.exercise.id,
				index + 1
			),
			sessionId: session.id,
			workoutId,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: createdAt,
			createdAt,
			updatedAt: createdAt
		}));
		const sessionSets = (
			await Promise.all(
				sessionExercises.map((sessionExercise, index) =>
					buildSessionSeedSetRows(
						sessionExercise.id,
						workoutExercises[index].exercise,
						createdAt,
						undefined,
						(order) => getScheduledSessionSetLogicalId(sessionExercise.id, order),
						database
					)
				)
			)
		).flat();

		try {
			await database.transaction(
				'rw',
				database.workoutSessions,
				database.sessionExercises,
				database.sessionSets,
				database.workouts,
				async () => {
					const conflictingSession = (
						await database.workoutSessions.where('dayKey').equals(dayKey).toArray()
					).find(
						(candidate) =>
							candidate.status === 'planned' ||
							candidate.status === 'in_progress' ||
							candidate.status === 'completed' ||
							candidate.status === 'abandoned'
					);

					if (conflictingSession) {
						throw new Error('A session already exists for today.');
					}

					const [parentPlan, exercisePlan, setPlan] = await Promise.all([
						planScheduledRowWrites(
							database.workoutSessions,
							[session],
							'A session already exists for today.'
						),
						planScheduledRowWrites(
							database.sessionExercises,
							sessionExercises,
							'Session exercises already exist for this scheduled session.'
						),
						planScheduledRowWrites(
							database.sessionSets,
							sessionSets,
							'Session sets already exist for this scheduled session.'
						)
					]);

					let parentWasWritten = false;

					try {
						if (parentPlan.tombstonedRows.length > 0) {
							await database.workoutSessions.put(session);
						} else {
							await database.workoutSessions.add(session);
						}
						parentWasWritten = true;

						await writeScheduledRows(database.sessionExercises, exercisePlan);
						await writeScheduledRows(database.sessionSets, setPlan);
						await database.workouts.update(workoutId, { updatedAt: createdAt });
					} catch (error) {
						if (parentWasWritten) {
							const report = await compensateFailedScheduledSessionCreation(
								database,
								session,
								sessionExercises,
								sessionSets,
								workout
							);

							if (report.cleanupErrors.length > 0 || report.remainingRowIds.length > 0) {
								throw new ScheduledSessionCompensationError(
									error,
									report.cleanupErrors,
									report.remainingRowIds,
									{ userId, session, sessionExercises, sessionSets, workout }
								);
							}
						}

						throw error;
					}
				}
			);
		} catch (error) {
			if (error instanceof ScheduledSessionCompensationError) {
				persistScheduledSessionCompensation(error);
				await repairScheduledSessionCompensationForOperation(operation, error);

				if (error.remainingRowIds.length > 0) {
					pendingScheduledSessionCompensations.set(compensationKey, error);
				}
			}

			throw error;
		}

		return summarizeSession(session, sessionExercises, sessionSets);
	});
}

type SessionLifecycleOperation = 'start' | 'timing' | 'complete' | 'delete';

type SessionLifecycleTableName =
	| 'workouts'
	| 'workoutExercises'
	| 'workoutSessions'
	| 'sessionExercises'
	| 'sessionSets';

type SessionLifecycleRow =
	| Workout
	| WorkoutExercise
	| WorkoutSession
	| SessionExercise
	| SessionSet;

type SessionLifecycleRestoreGuard = {
	kind: 'row-absent-or-matches';
	table: SessionLifecycleTableName;
	row: SessionLifecycleRow;
};

type SessionLifecycleUpdatedCompensationStep = {
	label: string;
	kind: 'updated';
	table: SessionLifecycleTableName;
	before: SessionLifecycleRow;
	after: SessionLifecycleRow;
};

type SessionLifecycleInsertedCompensationStep = {
	label: string;
	kind: 'inserted';
	table: SessionLifecycleTableName;
	after: SessionLifecycleRow;
};

type SessionLifecycleDeletedCompensationStep = {
	label: string;
	kind: 'deleted';
	table: SessionLifecycleTableName;
	before: SessionLifecycleRow;
	restoreGuard?: SessionLifecycleRestoreGuard;
};

type SessionLifecycleCompensationStep =
	| SessionLifecycleUpdatedCompensationStep
	| SessionLifecycleInsertedCompensationStep
	| SessionLifecycleDeletedCompensationStep;

type SessionLifecycleCompensationAttempt = {
	userId: string;
	operation: SessionLifecycleOperation;
	sessionId: string;
	compensationSteps: SessionLifecycleCompensationStep[];
};

const pendingSessionLifecycleCompensations = new Map<string, SessionLifecycleCompensationError>();

function getSessionLifecycleCompensationKey(
	userId: string,
	operation: SessionLifecycleOperation,
	sessionId: string
) {
	return `${userId}:${operation}:${sessionId}`;
}

export class SessionLifecycleCompensationError extends Error {
	readonly cleanupErrors: unknown[] = [];
	remainingMutationLabels: string[];
	journalEntry: CompensationJournalEntry<SessionLifecycleCompensationAttempt> | null = null;
	readonly durabilityErrors: unknown[] = [];

	constructor(
		readonly userId: string,
		readonly operation: SessionLifecycleOperation,
		readonly originalError: unknown,
		readonly sessionId: string,
		readonly compensationSteps: SessionLifecycleCompensationStep[]
	) {
		super(
			`${operation[0].toUpperCase()}${operation.slice(1)} failed and TinyTrain could not fully restore the session. Retry the action so the remaining changes can be repaired.`,
			{ cause: originalError }
		);
		this.name = 'SessionLifecycleCompensationError';
		this.remainingMutationLabels = compensationSteps.map(({ label }) => label);
	}
}

function isSessionLifecycleOperation(value: unknown): value is SessionLifecycleOperation {
	return value === 'start' || value === 'timing' || value === 'complete' || value === 'delete';
}

function isSessionLifecycleTableName(value: unknown): value is SessionLifecycleTableName {
	return (
		value === 'workouts' ||
		value === 'workoutExercises' ||
		value === 'workoutSessions' ||
		value === 'sessionExercises' ||
		value === 'sessionSets'
	);
}

function isSessionLifecycleRestoreGuard(value: unknown): value is SessionLifecycleRestoreGuard {
	return (
		isRecord(value) &&
		value.kind === 'row-absent-or-matches' &&
		isSessionLifecycleTableName(value.table) &&
		isStoredRow(value.row)
	);
}

function isSessionLifecycleCompensationStep(
	value: unknown
): value is SessionLifecycleCompensationStep {
	if (
		!isRecord(value) ||
		typeof value.label !== 'string' ||
		value.label.length === 0 ||
		!isSessionLifecycleTableName(value.table)
	) {
		return false;
	}

	if (value.kind === 'updated') {
		return (
			isStoredRow(value.before) && isStoredRow(value.after) && value.before.id === value.after.id
		);
	}

	if (value.kind === 'inserted') {
		return isStoredRow(value.after);
	}

	if (value.kind === 'deleted') {
		return (
			isStoredRow(value.before) &&
			(value.restoreGuard === undefined || isSessionLifecycleRestoreGuard(value.restoreGuard))
		);
	}

	return false;
}

function isSessionLifecycleCompensationAttempt(
	value: unknown
): value is SessionLifecycleCompensationAttempt {
	return Boolean(
		isRecord(value) &&
		typeof value.userId === 'string' &&
		isSessionLifecycleOperation(value.operation) &&
		typeof value.sessionId === 'string' &&
		Array.isArray(value.compensationSteps) &&
		value.compensationSteps.length > 0 &&
		value.compensationSteps.every(isSessionLifecycleCompensationStep)
	);
}

function getSessionLifecycleAttempt(
	error: SessionLifecycleCompensationError
): SessionLifecycleCompensationAttempt {
	return {
		userId: error.userId,
		operation: error.operation,
		sessionId: error.sessionId,
		compensationSteps: error.compensationSteps
	};
}

function markSessionLifecycleCompensationNonDurable(
	error: SessionLifecycleCompensationError,
	durabilityError: unknown
) {
	error.durabilityErrors.push(durabilityError);

	if (!error.message.includes('Recovery could not be saved for reload safety.')) {
		error.message += getCompensationJournalDurabilityMessage(durabilityError);
	}
}

function persistSessionLifecycleCompensation(error: SessionLifecycleCompensationError) {
	if (error.journalEntry) {
		return null;
	}

	try {
		error.journalEntry = persistCompensationJournalEntry({
			kind: 'session-lifecycle',
			userId: error.userId,
			operationKey: getSessionLifecycleCompensationKey(
				error.userId,
				error.operation,
				error.sessionId
			),
			sessionId: error.sessionId,
			payload: getSessionLifecycleAttempt(error)
		});
		return null;
	} catch (durabilityError) {
		return durabilityError;
	}
}

function removeSessionLifecycleCompensationJournal(error: SessionLifecycleCompensationError) {
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

function hydrateSessionLifecycleCompensations(userId: string, operationKey: string) {
	let entries: CompensationJournalEntry<SessionLifecycleCompensationAttempt>[];

	try {
		entries = readCompensationJournalEntries({
			userId,
			kind: 'session-lifecycle',
			operationKey,
			validatePayload: isSessionLifecycleCompensationAttempt
		});
	} catch {
		return [];
	}

	return entries.flatMap((entry) => {
		const attempt = entry.payload;

		if (attempt.userId !== userId) {
			return [];
		}

		const error = new SessionLifecycleCompensationError(
			attempt.userId,
			attempt.operation,
			new Error('Recovered an interrupted session repair from durable storage.'),
			attempt.sessionId,
			attempt.compensationSteps
		);
		error.journalEntry = entry;
		return [error];
	});
}

function createUpdatedRowCompensationStep<T extends SessionLifecycleRow>(
	label: string,
	table: SessionLifecycleTableName,
	before: T,
	after: T
): SessionLifecycleCompensationStep {
	return { label, kind: 'updated', table, before, after };
}

function createInsertedRowCompensationStep<T extends SessionLifecycleRow>(
	label: string,
	table: SessionLifecycleTableName,
	after: T
): SessionLifecycleCompensationStep {
	return { label, kind: 'inserted', table, after };
}

function createDeletedRowCompensationStep<T extends SessionLifecycleRow>(
	label: string,
	table: SessionLifecycleTableName,
	before: T,
	restoreGuard?: SessionLifecycleRestoreGuard
): SessionLifecycleCompensationStep {
	return { label, kind: 'deleted', table, before, ...(restoreGuard ? { restoreGuard } : {}) };
}

function getSessionLifecycleTable(
	database: SessionLifecycleDatabase,
	table: SessionLifecycleTableName
) {
	return database[table] as unknown as DataTable<SessionLifecycleRow>;
}

async function canRestoreSessionLifecycleStep(
	database: SessionLifecycleDatabase,
	guard: SessionLifecycleRestoreGuard | undefined
) {
	if (!guard) {
		return true;
	}

	const current = await getSessionLifecycleTable(database, guard.table).get(guard.row.id);
	return !current || scheduledRowStillMatches(current, guard.row);
}

async function compensateSessionLifecycleStep(
	database: SessionLifecycleDatabase,
	step: SessionLifecycleCompensationStep
) {
	const table = getSessionLifecycleTable(database, step.table);

	if (step.kind === 'updated') {
		const current = await table.get(step.after.id);

		if (current && scheduledRowStillMatches(current, step.after)) {
			await table.put(step.before);
		}
		return;
	}

	if (step.kind === 'inserted') {
		const current = await table.get(step.after.id);

		if (current && scheduledRowStillMatches(current, step.after)) {
			await table.delete(step.after.id);
		}
		return;
	}

	const current = await table.get(step.before.id);

	if (!current && (await canRestoreSessionLifecycleStep(database, step.restoreGuard))) {
		await table.put(step.before);
	}
}

async function hasOwnedSessionLifecycleMutation(
	database: SessionLifecycleDatabase,
	step: SessionLifecycleCompensationStep
) {
	const table = getSessionLifecycleTable(database, step.table);

	if (step.kind === 'updated' || step.kind === 'inserted') {
		const current = await table.get(step.after.id);
		return Boolean(current && scheduledRowStillMatches(current, step.after));
	}

	return (
		!(await table.get(step.before.id)) &&
		(await canRestoreSessionLifecycleStep(database, step.restoreGuard))
	);
}

type WorkoutExerciseSyncAttempt = {
	workout: Workout | undefined;
	previousWorkoutExercises: WorkoutExercise[];
	nextWorkoutExercises: WorkoutExercise[];
	workoutExerciseIdsToDelete: string[];
	now: string;
};

function appendWorkoutExerciseSyncCompensationSteps(
	compensationSteps: SessionLifecycleCompensationStep[],
	attempt: WorkoutExerciseSyncAttempt
) {
	const previousById = new Map(
		attempt.previousWorkoutExercises.map((workoutExercise) => [workoutExercise.id, workoutExercise])
	);

	for (const workoutExerciseId of attempt.workoutExerciseIdsToDelete) {
		const previousWorkoutExercise = previousById.get(workoutExerciseId);

		if (!previousWorkoutExercise) {
			continue;
		}

		compensationSteps.push(
			createDeletedRowCompensationStep(
				`workout exercise ${workoutExerciseId}`,
				'workoutExercises',
				previousWorkoutExercise
			)
		);
	}

	for (const nextWorkoutExercise of attempt.nextWorkoutExercises) {
		const previousWorkoutExercise = previousById.get(nextWorkoutExercise.id);

		if (previousWorkoutExercise) {
			if (!scheduledRowStillMatches(previousWorkoutExercise, nextWorkoutExercise)) {
				compensationSteps.push(
					createUpdatedRowCompensationStep(
						`workout exercise ${nextWorkoutExercise.id}`,
						'workoutExercises',
						previousWorkoutExercise,
						nextWorkoutExercise
					)
				);
			}
			continue;
		}

		compensationSteps.push(
			createInsertedRowCompensationStep(
				`workout exercise ${nextWorkoutExercise.id}`,
				'workoutExercises',
				nextWorkoutExercise
			)
		);
	}

	if (attempt.workout) {
		const nextWorkout: Workout = { ...attempt.workout, updatedAt: attempt.now };

		if (!scheduledRowStillMatches(attempt.workout, nextWorkout)) {
			compensationSteps.push(
				createUpdatedRowCompensationStep(
					`workout ${attempt.workout.id}`,
					'workouts',
					attempt.workout,
					nextWorkout
				)
			);
		}
	}
}

async function syncWorkoutTemplateForCompletion(
	database: Pick<SessionLifecycleDatabase, 'sessionExercises' | 'workoutExercises' | 'workouts'>,
	session: WorkoutSession,
	now: string,
	compensationSteps: SessionLifecycleCompensationStep[]
) {
	const [rawSessionExercises, previousWorkoutExercises, workout] = await Promise.all([
		database.sessionExercises.where('sessionId').equals(session.id).sortBy('order'),
		database.workoutExercises.where('workoutId').equals(session.workoutId).toArray(),
		database.workouts.get(session.workoutId)
	]);
	const sessionExercises = reconcileSessionExerciseOrderCollisions(rawSessionExercises);
	const previousByExerciseId = new Map(
		previousWorkoutExercises.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
	);
	const sessionExerciseIdSet = new Set(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId)
	);
	const workoutExerciseIdsToDelete = previousWorkoutExercises
		.filter((workoutExercise) => !sessionExerciseIdSet.has(workoutExercise.exerciseId))
		.map((workoutExercise) => workoutExercise.id);
	const nextWorkoutExercises = sessionExercises.map((sessionExercise, index) => {
		const previousWorkoutExercise = previousByExerciseId.get(sessionExercise.exerciseId);

		return {
			id: previousWorkoutExercise?.id ?? createId(),
			workoutId: session.workoutId,
			exerciseId: sessionExercise.exerciseId,
			order: index + 1,
			createdAt: previousWorkoutExercise?.createdAt ?? now,
			updatedAt: now
		} satisfies WorkoutExercise;
	});
	appendWorkoutExerciseSyncCompensationSteps(compensationSteps, {
		workout,
		previousWorkoutExercises,
		nextWorkoutExercises,
		workoutExerciseIdsToDelete,
		now
	});

	if (workoutExerciseIdsToDelete.length > 0) {
		await database.workoutExercises.bulkDelete(workoutExerciseIdsToDelete);
	}

	if (nextWorkoutExercises.length > 0) {
		await database.workoutExercises.bulkPut(nextWorkoutExercises);
	}

	const updatedWorkout = await database.workouts.update(session.workoutId, { updatedAt: now });

	if (updatedWorkout !== 1) {
		throw new Error('The workout disappeared while its exercise template was being updated.');
	}

	const [storedNextWorkoutExercises, storedDeletedWorkoutExercises, storedWorkout] =
		await Promise.all([
			database.workoutExercises.bulkGet(nextWorkoutExercises.map(({ id }) => id)),
			database.workoutExercises.bulkGet(workoutExerciseIdsToDelete),
			database.workouts.get(session.workoutId)
		]);
	const didWriteEveryNextExercise = storedNextWorkoutExercises.every((storedRow, index) => {
		const expectedRow = nextWorkoutExercises[index];
		return Boolean(storedRow && scheduledRowStillMatches(storedRow, expectedRow));
	});

	if (
		!didWriteEveryNextExercise ||
		storedDeletedWorkoutExercises.some(Boolean) ||
		storedWorkout?.updatedAt !== now
	) {
		throw new Error('The workout exercise template was only partially updated. Retry completion.');
	}
}

async function repairSessionLifecycleCompensationForOperation(
	operation: AuthenticatedDatabaseOperation,
	error: SessionLifecycleCompensationError
) {
	if (operation.userId !== error.userId) {
		throw new Error('Cannot repair a session operation owned by a different signed-in user.');
	}

	for (const step of [...error.compensationSteps].reverse()) {
		try {
			await compensateSessionLifecycleStep(operation.database, step);
		} catch (cleanupError) {
			error.cleanupErrors.push(
				new Error(`Failed to restore ${step.label}.`, { cause: cleanupError })
			);
		}
	}

	const remainingMutationLabels: string[] = [];

	for (const step of error.compensationSteps) {
		try {
			if (await hasOwnedSessionLifecycleMutation(operation.database, step)) {
				remainingMutationLabels.push(step.label);
			}
		} catch (verificationError) {
			error.cleanupErrors.push(
				new Error(`Failed to verify restoration of ${step.label}.`, {
					cause: verificationError
				})
			);
			remainingMutationLabels.push(step.label);
		}
	}

	error.remainingMutationLabels = remainingMutationLabels;
	const key = getSessionLifecycleCompensationKey(error.userId, error.operation, error.sessionId);

	if (
		remainingMutationLabels.length === 0 &&
		pendingSessionLifecycleCompensations.get(key) === error
	) {
		pendingSessionLifecycleCompensations.delete(key);
	}

	if (remainingMutationLabels.length === 0) {
		removeSessionLifecycleCompensationJournal(error);
	}

	return remainingMutationLabels.length === 0;
}

export async function repairSessionLifecycleCompensation(error: SessionLifecycleCompensationError) {
	return runAuthenticatedDatabaseOperation((operation) =>
		repairSessionLifecycleCompensationForOperation(operation, error)
	);
}

async function repairPendingSessionLifecycleCompensation(
	operationContext: AuthenticatedDatabaseOperation,
	operation: SessionLifecycleOperation,
	sessionId: string
) {
	const key = getSessionLifecycleCompensationKey(operationContext.userId, operation, sessionId);
	let pendingCompensation = pendingSessionLifecycleCompensations.get(key);

	if (!pendingCompensation) {
		for (const hydratedCompensation of hydrateSessionLifecycleCompensations(
			operationContext.userId,
			key
		)) {
			if (
				!(await repairSessionLifecycleCompensationForOperation(
					operationContext,
					hydratedCompensation
				))
			) {
				pendingCompensation = hydratedCompensation;
				pendingSessionLifecycleCompensations.set(key, hydratedCompensation);
				break;
			}
		}
	}

	if (
		pendingCompensation &&
		!(await repairSessionLifecycleCompensationForOperation(operationContext, pendingCompensation))
	) {
		throw pendingCompensation;
	}
}

async function throwAfterSessionLifecycleWriteFailure(
	operationContext: AuthenticatedDatabaseOperation,
	operation: SessionLifecycleOperation,
	sessionId: string,
	originalError: unknown,
	compensationSteps: SessionLifecycleCompensationStep[]
): Promise<never> {
	if (compensationSteps.length === 0) {
		throw originalError;
	}

	const compensationError = new SessionLifecycleCompensationError(
		operationContext.userId,
		operation,
		originalError,
		sessionId,
		compensationSteps
	);
	const durabilityError = persistSessionLifecycleCompensation(compensationError);
	const repaired = await repairSessionLifecycleCompensationForOperation(
		operationContext,
		compensationError
	);

	if (repaired && compensationError.cleanupErrors.length === 0) {
		throw originalError;
	}

	if (!repaired) {
		if (durabilityError) {
			markSessionLifecycleCompensationNonDurable(compensationError, durabilityError);
		}
		pendingSessionLifecycleCompensations.set(
			getSessionLifecycleCompensationKey(operationContext.userId, operation, sessionId),
			compensationError
		);
	}

	throw compensationError;
}

export async function startWorkoutSession(sessionId: string) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		const { database } = operation;
		await repairPendingSessionLifecycleCompensation(operation, 'start', sessionId);

		const now = timestamp();
		let didStart = false;
		let transactionResult: ReturnType<typeof summarizeSession> | undefined;
		const compensationSteps: SessionLifecycleCompensationStep[] = [];

		try {
			await database.transaction(
				'rw',
				database.workoutSessions,
				database.sessionExercises,
				database.sessionSets,
				async () => {
					const currentSession = await database.workoutSessions.get(sessionId);

					if (!currentSession) {
						throw new Error('Session not found.');
					}

					const sessionExercises = await database.sessionExercises
						.where('sessionId')
						.equals(sessionId)
						.toArray();
					const sessionExerciseIds = sessionExercises.map(({ id }) => id);
					const sessionSets =
						sessionExerciseIds.length === 0
							? []
							: await database.sessionSets
									.where('sessionExerciseId')
									.anyOf(sessionExerciseIds)
									.toArray();

					if (currentSession.status !== 'planned' && currentSession.status !== 'abandoned') {
						transactionResult = summarizeSession(currentSession, sessionExercises, sessionSets);
						return;
					}

					const isResuming = currentSession.status === 'abandoned';

					if (isResuming && currentSession.dayKey !== toDayKey(new Date())) {
						throw new Error("Only today's abandoned session can be resumed.");
					}

					const resumeTiming = isResuming ? buildSessionResumeTiming(currentSession) : null;
					const activityAt = resumeTiming?.updatedAt ?? now;
					const nextSessionExercises: SessionExercise[] = [];

					for (const sessionExercise of sessionExercises) {
						const nextSessionExercise: SessionExercise = {
							...sessionExercise,
							performedAt: resumeTiming
								? getResumedSessionExercisePerformedAt(sessionExercise, resumeTiming)
								: now,
							updatedAt: activityAt
						};

						if (scheduledRowStillMatches(sessionExercise, nextSessionExercise)) {
							nextSessionExercises.push(sessionExercise);
							continue;
						}

						const currentExercise = await database.sessionExercises.get(sessionExercise.id);

						if (!currentExercise || !scheduledRowStillMatches(currentExercise, sessionExercise)) {
							throw new Error('The session changed while it was being started. Retry the action.');
						}

						compensationSteps.push(
							createUpdatedRowCompensationStep(
								`session exercise ${sessionExercise.id}`,
								'sessionExercises',
								sessionExercise,
								nextSessionExercise
							)
						);
						const updated = await database.sessionExercises.update(sessionExercise.id, {
							performedAt: nextSessionExercise.performedAt,
							updatedAt: nextSessionExercise.updatedAt
						});

						if (updated !== 1) {
							throw new Error(
								'The session exercise disappeared while the session was being started.'
							);
						}
						nextSessionExercises.push(nextSessionExercise);
					}

					const nextSession: WorkoutSession = {
						...currentSession,
						status: 'in_progress',
						startedAt: resumeTiming?.startedAt ?? now,
						completedAt: undefined,
						updatedAt: activityAt
					};
					const latestSession = await database.workoutSessions.get(sessionId);

					if (!latestSession || !scheduledRowStillMatches(latestSession, currentSession)) {
						throw new Error('The session changed while it was being started. Retry the action.');
					}

					compensationSteps.push(
						createUpdatedRowCompensationStep(
							'session status',
							'workoutSessions',
							currentSession,
							nextSession
						)
					);
					const updated = await database.workoutSessions.update(sessionId, {
						status: nextSession.status,
						startedAt: nextSession.startedAt,
						completedAt: nextSession.completedAt,
						updatedAt: nextSession.updatedAt
					});

					if (updated !== 1) {
						throw new Error('The session disappeared while it was being started.');
					}
					didStart = true;
					transactionResult = summarizeSession(nextSession, nextSessionExercises, sessionSets);
				}
			);
		} catch (error) {
			await throwAfterSessionLifecycleWriteFailure(
				operation,
				'start',
				sessionId,
				error,
				compensationSteps
			);
		}

		if (!transactionResult) {
			throw new Error('Session not found.');
		}

		if (didStart) {
			void syncNow().catch((error) => {
				console.warn('Background Supabase sync failed.', error);
			});
		}

		return transactionResult;
	});
}

export async function completeWorkoutSession(sessionId: string) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		const { database, userId } = operation;
		await repairPendingSessionLifecycleCompensation(operation, 'complete', sessionId);

		const session = await database.workoutSessions.get(sessionId);

		if (!session) {
			throw new Error('Session not found.');
		}

		if (session.status === 'completed' || session.status === 'abandoned') {
			return;
		}

		await flushSessionInputDraftWithDatabase(database, sessionId, {}, userId);

		const now = timestamp();
		let didComplete = false;
		const compensationSteps: SessionLifecycleCompensationStep[] = [];

		try {
			await database.transaction(
				'rw',
				database.workoutSessions,
				database.sessionExercises,
				database.workoutExercises,
				database.workouts,
				async () => {
					const currentSession = await database.workoutSessions.get(sessionId);

					if (!currentSession) {
						throw new Error('Session not found.');
					}

					if (currentSession.status === 'completed' || currentSession.status === 'abandoned') {
						return;
					}

					if (currentSession.status !== 'in_progress') {
						throw new Error('Start the session before completing it.');
					}

					await syncWorkoutTemplateForCompletion(database, currentSession, now, compensationSteps);

					const latestSession = await database.workoutSessions.get(sessionId);

					if (!latestSession || !scheduledRowStillMatches(latestSession, currentSession)) {
						throw new Error('The session changed while it was being completed. Retry the action.');
					}

					const nextSession: WorkoutSession = {
						...currentSession,
						status: 'completed',
						startedAt: currentSession.startedAt ?? now,
						completedAt: now,
						updatedAt: now
					};
					compensationSteps.push(
						createUpdatedRowCompensationStep(
							'session completion',
							'workoutSessions',
							currentSession,
							nextSession
						)
					);
					const updated = await database.workoutSessions.update(sessionId, {
						status: nextSession.status,
						startedAt: nextSession.startedAt,
						completedAt: nextSession.completedAt,
						updatedAt: nextSession.updatedAt
					});

					if (updated !== 1) {
						throw new Error('The session disappeared while it was being completed.');
					}
					didComplete = true;
				}
			);
		} catch (error) {
			await throwAfterSessionLifecycleWriteFailure(
				operation,
				'complete',
				sessionId,
				error,
				compensationSteps
			);
		}

		if (!didComplete) {
			return;
		}

		void syncNow().catch((error) => {
			console.warn('Background Supabase sync failed.', error);
		});
	});
}

export async function updateWorkoutSessionTiming(
	sessionId: string,
	nextStartedAt: string,
	nextCompletedAt: string | undefined,
	baseTiming: { startedAt: string | undefined; completedAt: string | undefined }
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		const { database } = operation;
		await repairPendingSessionLifecycleCompensation(operation, 'timing', sessionId);

		const session = await database.workoutSessions.get(sessionId);

		if (!session) {
			throw new Error('Session not found.');
		}

		const startedAtDate = new Date(nextStartedAt);
		const completedAtDate = nextCompletedAt ? new Date(nextCompletedAt) : null;

		if (Number.isNaN(startedAtDate.getTime())) {
			throw new Error('Start time is invalid.');
		}

		if (completedAtDate && Number.isNaN(completedAtDate.getTime())) {
			throw new Error('End time is invalid.');
		}

		if (completedAtDate && completedAtDate.getTime() < startedAtDate.getTime()) {
			throw new Error('End time must be after the start time.');
		}

		const normalizedStartedAt = timestamp(startedAtDate);
		const normalizedCompletedAt = completedAtDate ? timestamp(completedAtDate) : undefined;
		const didChangeStartedAt = normalizedStartedAt !== baseTiming.startedAt;
		const didChangeCompletedAt = normalizedCompletedAt !== baseTiming.completedAt;

		if (session.status === 'planned') {
			throw new Error('Start the session before editing its time.');
		}

		if (session.status === 'completed' && !completedAtDate) {
			throw new Error('End time is required for a completed session.');
		}

		if (!didChangeStartedAt && !didChangeCompletedAt) {
			return;
		}

		const compensationSteps: SessionLifecycleCompensationStep[] = [];

		try {
			await database.transaction(
				'rw',
				database.workoutSessions,
				database.sessionExercises,
				async () => {
					const currentSession = await database.workoutSessions.get(sessionId);

					if (!currentSession) {
						throw new Error('Session not found.');
					}

					if (currentSession.status === 'planned') {
						throw new Error('Start the session before editing its time.');
					}

					if (
						(didChangeStartedAt && currentSession.startedAt !== baseTiming.startedAt) ||
						(didChangeCompletedAt && currentSession.completedAt !== baseTiming.completedAt)
					) {
						throw new Error(
							'The session time changed while you were editing. Your changes were not saved.'
						);
					}

					const effectiveStartedAt = didChangeStartedAt
						? normalizedStartedAt
						: currentSession.startedAt;
					const effectiveCompletedAt = didChangeCompletedAt
						? normalizedCompletedAt
						: currentSession.completedAt;
					const effectiveStartedAtDate = effectiveStartedAt ? new Date(effectiveStartedAt) : null;
					const effectiveCompletedAtDate = effectiveCompletedAt
						? new Date(effectiveCompletedAt)
						: null;

					if (!effectiveStartedAtDate || Number.isNaN(effectiveStartedAtDate.getTime())) {
						throw new Error('Start time is invalid.');
					}

					if (effectiveCompletedAtDate && Number.isNaN(effectiveCompletedAtDate.getTime())) {
						throw new Error('End time is invalid.');
					}

					if (
						effectiveCompletedAtDate &&
						effectiveCompletedAtDate.getTime() < effectiveStartedAtDate.getTime()
					) {
						throw new Error('End time must be after the start time.');
					}

					if (currentSession.status === 'completed' && !effectiveCompletedAtDate) {
						throw new Error('End time is required for a completed session.');
					}

					const nextDayKey = toDayKey(effectiveStartedAtDate);

					if (didChangeStartedAt) {
						const conflictingSession = (
							await database.workoutSessions.where('dayKey').equals(nextDayKey).toArray()
						).find((candidate) => candidate.id !== sessionId);

						if (conflictingSession) {
							throw new Error('A session already exists for that day.');
						}
					}

					const currentStartedAtMs = currentSession.startedAt
						? new Date(currentSession.startedAt).getTime()
						: NaN;
					const startedAtDeltaMs =
						!didChangeStartedAt || Number.isNaN(currentStartedAtMs)
							? 0
							: effectiveStartedAtDate.getTime() - currentStartedAtMs;
					const now = timestamp();
					const nextSession: WorkoutSession = { ...currentSession, updatedAt: now };

					if (didChangeStartedAt) {
						nextSession.startedAt = normalizedStartedAt;
						nextSession.dayKey = nextDayKey;
					}

					if (didChangeCompletedAt) {
						nextSession.completedAt = normalizedCompletedAt;
					}

					if (startedAtDeltaMs !== 0) {
						const sessionExercises = await database.sessionExercises
							.where('sessionId')
							.equals(sessionId)
							.toArray();

						for (const sessionExercise of sessionExercises) {
							const performedAtMs = new Date(sessionExercise.performedAt).getTime();
							const nextPerformedAt = Number.isNaN(performedAtMs)
								? effectiveStartedAtDate
								: new Date(performedAtMs + startedAtDeltaMs);
							const nextSessionExercise: SessionExercise = {
								...sessionExercise,
								performedAt: timestamp(nextPerformedAt),
								updatedAt: now
							};
							const currentExercise = await database.sessionExercises.get(sessionExercise.id);

							if (!currentExercise || !scheduledRowStillMatches(currentExercise, sessionExercise)) {
								throw new Error(
									'The session exercises changed while the time was being edited. Retry the action.'
								);
							}

							compensationSteps.push(
								createUpdatedRowCompensationStep(
									`session exercise ${sessionExercise.id}`,
									'sessionExercises',
									sessionExercise,
									nextSessionExercise
								)
							);
							const updated = await database.sessionExercises.update(sessionExercise.id, {
								performedAt: nextSessionExercise.performedAt,
								updatedAt: nextSessionExercise.updatedAt
							});

							if (updated !== 1) {
								throw new Error(
									'The session exercise disappeared while the time was being edited.'
								);
							}
						}
					}

					const latestSession = await database.workoutSessions.get(sessionId);

					if (!latestSession || !scheduledRowStillMatches(latestSession, currentSession)) {
						throw new Error(
							'The session time changed while you were editing. Your changes were not saved.'
						);
					}

					compensationSteps.push(
						createUpdatedRowCompensationStep(
							'session timing',
							'workoutSessions',
							currentSession,
							nextSession
						)
					);
					const updated = await database.workoutSessions.update(sessionId, {
						startedAt: nextSession.startedAt,
						completedAt: nextSession.completedAt,
						dayKey: nextSession.dayKey,
						updatedAt: nextSession.updatedAt
					});

					if (updated !== 1) {
						throw new Error('The session disappeared while the time was being edited.');
					}
				}
			);
		} catch (error) {
			await throwAfterSessionLifecycleWriteFailure(
				operation,
				'timing',
				sessionId,
				error,
				compensationSteps
			);
		}

		void syncNow().catch((error) => {
			console.warn('Background Supabase sync failed.', error);
		});
	});
}

export async function getEditableSession(sessionId: string) {
	const expectedUserId = getActiveCloudUser().userId;
	await ensureDbOpen();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		if (expectedUserId && operation.userId !== expectedUserId) {
			throw new Error('The signed-in user changed before the session could be loaded.');
		}

		const session = await operation.database.workoutSessions.get(sessionId);

		if (!session) {
			return null;
		}

		await ensureEditableSessionSeedRows(
			session,
			await listSessionExerciseDetailsWithDatabase(operation.database, sessionId)
		);

		return getSessionOverviewWithDatabase(operation.database, sessionId);
	});
}

export type WorkoutSessionDeleteExpectation = Pick<WorkoutSession, 'status' | 'updatedAt'>;

export async function deleteWorkoutSession(
	sessionId: string,
	expectation: WorkoutSessionDeleteExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		const { database } = operation;
		await repairPendingSessionLifecycleCompensation(operation, 'delete', sessionId);

		const compensationSteps: SessionLifecycleCompensationStep[] = [];

		try {
			await database.transaction(
				'rw',
				database.workoutSessions,
				database.sessionExercises,
				database.sessionSets,
				database.workouts,
				async () => {
					const session = await database.workoutSessions.get(sessionId);

					if (!session) {
						return;
					}

					if (
						session.status !== expectation.status ||
						session.updatedAt !== expectation.updatedAt
					) {
						throw new Error(
							'The session changed after you confirmed deletion. Review the latest session before deleting it.'
						);
					}

					const sessionExercises = await database.sessionExercises
						.where('sessionId')
						.equals(sessionId)
						.toArray();
					const sessionExerciseIds = sessionExercises.map(({ id }) => id);
					const sessionSets =
						sessionExerciseIds.length === 0
							? []
							: await database.sessionSets
									.where('sessionExerciseId')
									.anyOf(sessionExerciseIds)
									.toArray();
					const workout = await database.workouts.get(session.workoutId);
					const canRestoreGraph: SessionLifecycleRestoreGuard = {
						kind: 'row-absent-or-matches',
						table: 'workoutSessions',
						row: session
					};

					for (const sessionSet of sessionSets) {
						const currentSet = await database.sessionSets.get(sessionSet.id);

						if (!currentSet || !scheduledRowStillMatches(currentSet, sessionSet)) {
							throw new Error('The session changed while it was being deleted. Retry the action.');
						}

						compensationSteps.push(
							createDeletedRowCompensationStep(
								`session set ${sessionSet.id}`,
								'sessionSets',
								sessionSet,
								canRestoreGraph
							)
						);
						await database.sessionSets.delete(sessionSet.id);
						const remainingSet = await database.sessionSets.get(sessionSet.id);

						if (remainingSet && scheduledRowStillMatches(remainingSet, sessionSet)) {
							throw new Error('A session set could not be deleted. Retry the action.');
						}
					}

					for (const sessionExercise of sessionExercises) {
						const currentExercise = await database.sessionExercises.get(sessionExercise.id);

						if (!currentExercise || !scheduledRowStillMatches(currentExercise, sessionExercise)) {
							throw new Error('The session changed while it was being deleted. Retry the action.');
						}

						compensationSteps.push(
							createDeletedRowCompensationStep(
								`session exercise ${sessionExercise.id}`,
								'sessionExercises',
								sessionExercise,
								canRestoreGraph
							)
						);
						await database.sessionExercises.delete(sessionExercise.id);
						const remainingExercise = await database.sessionExercises.get(sessionExercise.id);

						if (remainingExercise && scheduledRowStillMatches(remainingExercise, sessionExercise)) {
							throw new Error('A session exercise could not be deleted. Retry the action.');
						}
					}

					if (workout) {
						const latestWorkout = await database.workouts.get(workout.id);

						if (latestWorkout && scheduledRowStillMatches(latestWorkout, workout)) {
							const nextWorkout: Workout = { ...workout, updatedAt: timestamp() };

							if (!scheduledRowStillMatches(workout, nextWorkout)) {
								compensationSteps.push(
									createUpdatedRowCompensationStep(
										`workout ${workout.id}`,
										'workouts',
										workout,
										nextWorkout
									)
								);
								const updated = await database.workouts.update(workout.id, {
									updatedAt: nextWorkout.updatedAt
								});

								if (updated !== 1) {
									throw new Error('The workout changed while its session was being deleted.');
								}
							}
						}
					}

					const latestSession = await database.workoutSessions.get(sessionId);

					if (!latestSession || !scheduledRowStillMatches(latestSession, session)) {
						throw new Error('The session changed while it was being deleted. Retry the action.');
					}

					compensationSteps.push(
						createDeletedRowCompensationStep('session', 'workoutSessions', session)
					);
					await database.workoutSessions.delete(sessionId);
					const remainingSession = await database.workoutSessions.get(sessionId);

					if (remainingSession && scheduledRowStillMatches(remainingSession, session)) {
						throw new Error('The session could not be deleted. Retry the action.');
					}
				}
			);
		} catch (error) {
			await throwAfterSessionLifecycleWriteFailure(
				operation,
				'delete',
				sessionId,
				error,
				compensationSteps
			);
		}
	});
}
