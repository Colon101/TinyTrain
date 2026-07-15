import { getExercise } from '../exercises';
import {
	getCompensationJournalDurabilityMessage,
	persistCompensationJournalEntry,
	readCompensationJournalEntries,
	removeCompensationJournalEntry,
	type CompensationJournalEntry,
	type CompensationJournalKind
} from '../compensation-journal';
import type {
	SessionExercise,
	SessionInputField,
	SessionSet,
	SessionStructuralEditExpectation,
	WorkoutSession
} from '../models';
import {
	requireLoggedInUser,
	runAuthenticatedDatabaseOperation,
	type AuthenticatedDatabaseOperation,
	type AuthenticatedOperationDatabase
} from '../runtime';
import {
	captureSessionInputDraftVersionSnapshot,
	finalizeSessionInputDraftIfUnchanged,
	finalizeSessionInputDraftSetsIfUnchanged,
	sessionInputDraftVersionSnapshotMatches,
	type SessionInputDraftVersionSnapshot
} from '../session-drafts';
import {
	compareSessionExerciseRows,
	compareSessionSetRows,
	groupSessionSetRows,
	reconcileSessionExerciseOrderCollisions,
	sessionSetMatchesSessionExercise,
	timestamp,
	withSessionSetDefaults
} from '../shared';
import { listWorkoutExercises } from '../workouts';
import { updateSessionSetInputs } from './inputs';
import { buildSeedSessionSetRows, buildSessionSeedSetRows } from './seeding';
import {
	getAddedSessionExerciseId,
	getResetSessionExerciseId,
	getSessionExerciseSeedSetLogicalId
} from './schedule-identity';

type SessionEditCompensationMutation =
	| {
			table: 'sessionSets';
			id: string;
			before: SessionSet | undefined;
			after: SessionSet | undefined;
	  }
	| {
			table: 'sessionExercises';
			id: string;
			before: SessionExercise | undefined;
			after: SessionExercise | undefined;
	  }
	| {
			table: 'workoutSessions';
			id: string;
			before: WorkoutSession | undefined;
			after: WorkoutSession | undefined;
	  };

type SessionEditCompensationAttempt = {
	userId: string;
	operation: string;
	sessionId: string | null;
	scopeKeys: string[];
	mutations: SessionEditCompensationMutation[];
};

type SessionEditCompensationReport = {
	cleanupErrors: unknown[];
	remainingRowIds: string[];
};

export class SessionEditCompensationError extends Error {
	readonly cleanupErrors: unknown[];
	remainingRowIds: string[];
	journalEntry: CompensationJournalEntry<SessionEditCompensationAttempt> | null = null;
	readonly durabilityErrors: unknown[] = [];

	constructor(
		readonly originalError: unknown,
		cleanupErrors: unknown[],
		remainingRowIds: string[],
		readonly attempt: SessionEditCompensationAttempt
	) {
		super(
			`${attempt.operation} failed, and TinyTrain could not fully restore the previous session data. Retry the edit so the remaining temporary changes can be repaired.`,
			{ cause: new AggregateError([originalError, ...cleanupErrors]) }
		);
		this.name = 'SessionEditCompensationError';
		this.cleanupErrors = [...cleanupErrors];
		this.remainingRowIds = [...remainingRowIds];
	}

	get userId() {
		return this.attempt.userId;
	}

	get compensationErrors() {
		return this.cleanupErrors;
	}
}

type SessionReorderCompensationAttempt = {
	userId: string;
	sessionId: string;
	beforeSessionExercises: SessionExercise[];
	afterSessionExercises: SessionExercise[];
	sessionMetadata: SessionCreationMetadataAttempt<WorkoutSession>;
};

type SessionReorderCompensationReport = {
	cleanupErrors: unknown[];
	remainingRowIds: string[];
};

export class SessionReorderCompensationError extends Error {
	readonly cleanupErrors: unknown[];
	remainingRowIds: string[];
	journalEntry: CompensationJournalEntry<SessionReorderCompensationAttempt> | null = null;
	readonly durabilityErrors: unknown[] = [];

	constructor(
		readonly originalError: unknown,
		cleanupErrors: unknown[],
		remainingRowIds: string[],
		readonly attempt: SessionReorderCompensationAttempt
	) {
		super(
			'Session reorder failed, and TinyTrain could not fully restore the previous order. Retry the reorder so the remaining temporary order changes can be repaired.',
			{ cause: new AggregateError([originalError, ...cleanupErrors]) }
		);
		this.name = 'SessionReorderCompensationError';
		this.cleanupErrors = [...cleanupErrors];
		this.remainingRowIds = [...remainingRowIds];
	}
}

export type SessionDestructiveEditExpectation = {
	sessionId: string;
	sessionExercises: SessionExercise[];
	sessionSets: SessionSet[];
	inputDraft: SessionInputDraftVersionSnapshot;
};

type SessionCreationMetadataAttempt<T extends { id: string }> = {
	before: T;
	after: T;
};

type SessionCreationCompensationAttempt = {
	userId: string;
	operation: string;
	sessionId: string;
	sessionExercises: SessionExercise[];
	sessionSets: SessionSet[];
	sessionExerciseMetadata?: SessionCreationMetadataAttempt<SessionExercise>;
	sessionMetadata: SessionCreationMetadataAttempt<WorkoutSession>;
};

type SessionCreationCompensationReport = {
	cleanupErrors: unknown[];
	remainingRowIds: string[];
};

const pendingSessionCreationCompensations = new Map<
	string,
	Set<SessionCreationCompensationError>
>();
const pendingSessionReorderCompensations = new Map<string, Set<SessionReorderCompensationError>>();
const pendingSessionEditCompensations = new Map<string, Set<SessionEditCompensationError>>();

type SessionEditingDatabase = AuthenticatedOperationDatabase;

function getOwnedSessionOperationKey(userId: string, sessionId: string) {
	return `${userId}\u0000${sessionId}`;
}

function getSessionEditExerciseScopeKey(sessionExerciseId: string) {
	return `exercise:${sessionExerciseId}`;
}

function getSessionEditSetScopeKey(sessionSetId: string) {
	return `set:${sessionSetId}`;
}

function getSessionEditSessionScopeKey(sessionId: string) {
	return `session:${sessionId}`;
}

function requireCompensationOwner(
	operation: Pick<AuthenticatedDatabaseOperation, 'userId'>,
	attempt: Pick<
		| SessionCreationCompensationAttempt
		| SessionReorderCompensationAttempt
		| SessionEditCompensationAttempt,
		'userId'
	>
) {
	if (operation.userId !== attempt.userId) {
		throw new Error('Pending session compensation belongs to a different authenticated user.');
	}
}

export class SessionCreationCompensationError extends Error {
	readonly cleanupErrors: unknown[];
	remainingRowIds: string[];
	journalEntry: CompensationJournalEntry<SessionCreationCompensationAttempt> | null = null;
	readonly durabilityErrors: unknown[] = [];

	constructor(
		readonly originalError: unknown,
		cleanupErrors: unknown[],
		remainingRowIds: string[],
		readonly attempt: SessionCreationCompensationAttempt
	) {
		super(
			`${attempt.operation} failed, and TinyTrain could not fully remove the incomplete session rows. Retry the edit so the remaining temporary data can be repaired.`,
			{ cause: new AggregateError([originalError, ...cleanupErrors]) }
		);
		this.name = 'SessionCreationCompensationError';
		this.cleanupErrors = [...cleanupErrors];
		this.remainingRowIds = [...remainingRowIds];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredSessionRow(
	value: unknown
): value is Record<string, unknown> & { id: string; createdAt: string; updatedAt: string } {
	return Boolean(
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
}

function isSessionCreationMetadataAttempt(
	value: unknown
): value is SessionCreationMetadataAttempt<SessionExercise | WorkoutSession> {
	return Boolean(
		isRecord(value) &&
		isStoredSessionRow(value.before) &&
		isStoredSessionRow(value.after) &&
		value.before.id === value.after.id
	);
}

function isSessionCreationCompensationAttempt(
	value: unknown
): value is SessionCreationCompensationAttempt {
	return Boolean(
		isRecord(value) &&
		typeof value.userId === 'string' &&
		typeof value.operation === 'string' &&
		typeof value.sessionId === 'string' &&
		Array.isArray(value.sessionExercises) &&
		value.sessionExercises.every(isStoredSessionRow) &&
		Array.isArray(value.sessionSets) &&
		value.sessionSets.every(isStoredSessionRow) &&
		(value.sessionExerciseMetadata === undefined ||
			isSessionCreationMetadataAttempt(value.sessionExerciseMetadata)) &&
		isSessionCreationMetadataAttempt(value.sessionMetadata) &&
		value.sessionMetadata.before.id === value.sessionId
	);
}

function isSessionReorderCompensationAttempt(
	value: unknown
): value is SessionReorderCompensationAttempt {
	if (!isRecord(value)) {
		return false;
	}

	const beforeSessionExercises = value.beforeSessionExercises;
	const afterSessionExercises = value.afterSessionExercises;
	if (
		typeof value.userId !== 'string' ||
		typeof value.sessionId !== 'string' ||
		!Array.isArray(beforeSessionExercises) ||
		!beforeSessionExercises.every(isStoredSessionRow) ||
		!Array.isArray(afterSessionExercises) ||
		!afterSessionExercises.every(isStoredSessionRow) ||
		beforeSessionExercises.length !== afterSessionExercises.length ||
		!isSessionCreationMetadataAttempt(value.sessionMetadata) ||
		value.sessionMetadata.before.id !== value.sessionId
	) {
		return false;
	}

	return beforeSessionExercises.every((row, index) => row.id === afterSessionExercises[index].id);
}

function isSessionEditCompensationMutation(
	value: unknown
): value is SessionEditCompensationMutation {
	if (
		!isRecord(value) ||
		(value.table !== 'sessionSets' &&
			value.table !== 'sessionExercises' &&
			value.table !== 'workoutSessions') ||
		typeof value.id !== 'string' ||
		(value.before !== undefined && !isStoredSessionRow(value.before)) ||
		(value.after !== undefined && !isStoredSessionRow(value.after)) ||
		(!value.before && !value.after)
	) {
		return false;
	}

	return (
		(!value.before || value.before.id === value.id) && (!value.after || value.after.id === value.id)
	);
}

function isSessionEditCompensationAttempt(value: unknown): value is SessionEditCompensationAttempt {
	return Boolean(
		isRecord(value) &&
		typeof value.userId === 'string' &&
		typeof value.operation === 'string' &&
		(value.sessionId === null || typeof value.sessionId === 'string') &&
		Array.isArray(value.scopeKeys) &&
		value.scopeKeys.length > 0 &&
		value.scopeKeys.every((scopeKey) => typeof scopeKey === 'string') &&
		Array.isArray(value.mutations) &&
		value.mutations.length > 0 &&
		value.mutations.every(isSessionEditCompensationMutation)
	);
}

type DurableEditingCompensationError<T> = Error & {
	journalEntry: CompensationJournalEntry<T> | null;
	durabilityErrors: unknown[];
	cleanupErrors: unknown[];
};

function markEditingCompensationNonDurable<T>(
	error: DurableEditingCompensationError<T>,
	durabilityError: unknown
) {
	error.durabilityErrors.push(durabilityError);

	if (!error.message.includes('Recovery could not be saved for reload safety.')) {
		error.message += getCompensationJournalDurabilityMessage(durabilityError);
	}
}

function persistEditingCompensation<T>(
	error: DurableEditingCompensationError<T>,
	kind: CompensationJournalKind,
	userId: string,
	operationKey: string,
	sessionId: string,
	payload: T
) {
	if (error.journalEntry) {
		return;
	}

	try {
		error.journalEntry = persistCompensationJournalEntry({
			kind,
			userId,
			operationKey,
			sessionId,
			payload
		});
	} catch (durabilityError) {
		markEditingCompensationNonDurable(error, durabilityError);
	}
}

function removeEditingCompensationJournal<T>(error: DurableEditingCompensationError<T>) {
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

function getSessionEditJournalOperationKey(attempt: SessionEditCompensationAttempt) {
	return `${attempt.userId}\u0000${attempt.sessionId ?? 'orphan'}\u0000${attempt.operation}\u0000${attempt.scopeKeys.join('\u0000')}`;
}

function creationRowStillMatches<T extends { id: string }>(stored: T, expected: T) {
	return Object.entries(expected).every(
		([key, value]) => (stored as unknown as Record<string, unknown>)[key] === value
	);
}

async function findOwnedSessionCreationRows(
	database: SessionEditingDatabase,
	attempt: SessionCreationCompensationAttempt
) {
	const [storedSessionExercises, storedSessionSets, storedSessionExercise, storedSession] =
		await Promise.all([
			database.sessionExercises.bulkGet(
				attempt.sessionExercises.map((sessionExercise) => sessionExercise.id)
			),
			database.sessionSets.bulkGet(attempt.sessionSets.map((sessionSet) => sessionSet.id)),
			attempt.sessionExerciseMetadata
				? database.sessionExercises.get(attempt.sessionExerciseMetadata.after.id)
				: Promise.resolve(undefined),
			database.workoutSessions.get(attempt.sessionMetadata.after.id)
		]);

	return [
		...storedSessionExercises.flatMap((storedRow, index) =>
			storedRow && creationRowStillMatches(storedRow, attempt.sessionExercises[index])
				? [storedRow.id]
				: []
		),
		...storedSessionSets.flatMap((storedRow, index) =>
			storedRow && creationRowStillMatches(storedRow, attempt.sessionSets[index])
				? [storedRow.id]
				: []
		),
		...(storedSessionExercise &&
		attempt.sessionExerciseMetadata &&
		creationRowStillMatches(storedSessionExercise, attempt.sessionExerciseMetadata.after)
			? [storedSessionExercise.id]
			: []),
		...(storedSession && creationRowStillMatches(storedSession, attempt.sessionMetadata.after)
			? [storedSession.id]
			: [])
	];
}

async function compensateFailedSessionCreation(
	database: SessionEditingDatabase,
	attempt: SessionCreationCompensationAttempt
): Promise<SessionCreationCompensationReport> {
	const cleanupErrors: unknown[] = [];

	async function attemptCleanup(label: string, callback: () => Promise<unknown>) {
		try {
			await callback();
		} catch (error) {
			cleanupErrors.push(new Error(label, { cause: error }));
		}
	}

	await attemptCleanup('Failed to remove incomplete session sets.', async () => {
		const storedRows = await database.sessionSets.bulkGet(
			attempt.sessionSets.map((sessionSet) => sessionSet.id)
		);
		const ownedIds = storedRows.flatMap((storedRow, index) =>
			storedRow && creationRowStillMatches(storedRow, attempt.sessionSets[index])
				? [storedRow.id]
				: []
		);

		if (ownedIds.length > 0) {
			await database.sessionSets.bulkDelete(ownedIds);
		}
	});
	await attemptCleanup('Failed to remove incomplete session exercises.', async () => {
		const storedRows = await database.sessionExercises.bulkGet(
			attempt.sessionExercises.map((sessionExercise) => sessionExercise.id)
		);
		const ownedIds = storedRows.flatMap((storedRow, index) =>
			storedRow && creationRowStillMatches(storedRow, attempt.sessionExercises[index])
				? [storedRow.id]
				: []
		);

		if (ownedIds.length > 0) {
			await database.sessionExercises.bulkDelete(ownedIds);
		}
	});
	await attemptCleanup('Failed to restore session exercise metadata.', async () => {
		if (!attempt.sessionExerciseMetadata) {
			return;
		}

		const storedSessionExercise = await database.sessionExercises.get(
			attempt.sessionExerciseMetadata.after.id
		);

		if (
			storedSessionExercise &&
			creationRowStillMatches(storedSessionExercise, attempt.sessionExerciseMetadata.after)
		) {
			await database.sessionExercises.put(attempt.sessionExerciseMetadata.before);
		}
	});
	await attemptCleanup('Failed to restore session metadata.', async () => {
		const storedSession = await database.workoutSessions.get(attempt.sessionMetadata.after.id);

		if (storedSession && creationRowStillMatches(storedSession, attempt.sessionMetadata.after)) {
			await database.workoutSessions.put(attempt.sessionMetadata.before);
		}
	});

	let remainingRowIds = [
		...attempt.sessionSets,
		...attempt.sessionExercises,
		...(attempt.sessionExerciseMetadata ? [attempt.sessionExerciseMetadata.after] : []),
		attempt.sessionMetadata.after
	].map((row) => row.id);

	try {
		remainingRowIds = await findOwnedSessionCreationRows(database, attempt);
	} catch (error) {
		cleanupErrors.push(
			new Error('Failed to verify that incomplete session rows were removed.', { cause: error })
		);
	}

	return { cleanupErrors, remainingRowIds: [...new Set(remainingRowIds)] };
}

async function repairSessionCreationCompensationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	error: SessionCreationCompensationError
) {
	requireCompensationOwner(operation, error.attempt);
	const report = await compensateFailedSessionCreation(operation.database, error.attempt);
	error.cleanupErrors.push(...report.cleanupErrors);
	error.remainingRowIds = report.remainingRowIds;

	if (error.remainingRowIds.length === 0) {
		removeEditingCompensationJournal(error);
		const operationKey = getOwnedSessionOperationKey(error.attempt.userId, error.attempt.sessionId);
		const pendingCompensations = pendingSessionCreationCompensations.get(operationKey);
		pendingCompensations?.delete(error);

		if (pendingCompensations?.size === 0) {
			pendingSessionCreationCompensations.delete(operationKey);
		}
	}

	return error.remainingRowIds.length === 0;
}

export async function repairSessionCreationCompensation(error: SessionCreationCompensationError) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		repairSessionCreationCompensationWithOperation(operation, error)
	);
}

async function repairPendingSessionCreationCompensation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string
) {
	const operationKey = getOwnedSessionOperationKey(operation.userId, sessionId);
	let pendingCompensations = pendingSessionCreationCompensations.get(operationKey);

	if (!pendingCompensations) {
		try {
			const hydratedErrors = readCompensationJournalEntries({
				userId: operation.userId,
				kind: 'session-creation',
				operationKey,
				validatePayload: isSessionCreationCompensationAttempt
			}).flatMap((entry) => {
				if (entry.payload.userId !== operation.userId || entry.payload.sessionId !== sessionId) {
					return [];
				}

				const error = new SessionCreationCompensationError(
					new Error('Recovered an interrupted session creation repair from durable storage.'),
					[],
					[
						...entry.payload.sessionExercises.map(({ id }) => id),
						...entry.payload.sessionSets.map(({ id }) => id),
						entry.payload.sessionId
					],
					entry.payload
				);
				error.journalEntry = entry;
				return [error];
			});

			if (hydratedErrors.length > 0) {
				pendingCompensations = new Set(hydratedErrors);
				pendingSessionCreationCompensations.set(operationKey, pendingCompensations);
			}
		} catch {
			// A subsequent incomplete repair will surface an explicit non-durable warning.
		}
	}

	if (!pendingCompensations) {
		return;
	}

	for (const pendingCompensation of [...pendingCompensations]) {
		await repairSessionCreationCompensationWithOperation(operation, pendingCompensation);
	}

	const stillPending = pendingSessionCreationCompensations.get(operationKey);

	if (stillPending && stillPending.size > 0) {
		throw stillPending.values().next().value;
	}
}

async function throwAfterSessionCreationCompensation(
	database: SessionEditingDatabase,
	originalError: unknown,
	attempt: SessionCreationCompensationAttempt
): Promise<never> {
	const report = await compensateFailedSessionCreation(database, attempt);

	if (report.cleanupErrors.length > 0 || report.remainingRowIds.length > 0) {
		throw new SessionCreationCompensationError(
			originalError,
			report.cleanupErrors,
			report.remainingRowIds,
			attempt
		);
	}

	throw originalError;
}

async function compensateSessionEdit(
	database: SessionEditingDatabase,
	originalError: unknown,
	attempt: SessionEditCompensationAttempt
): Promise<never> {
	const report = await compensateFailedSessionEdit(database, attempt);

	if (report.cleanupErrors.length > 0 || report.remainingRowIds.length > 0) {
		const error = new SessionEditCompensationError(
			originalError,
			report.cleanupErrors,
			report.remainingRowIds,
			attempt
		);
		trackIncompleteSessionEdit(error);
		throw error;
	}

	throw originalError;
}

async function requireRowUpdate(update: Promise<number>, message: string) {
	if ((await update) === 0) {
		throw new Error(message);
	}
}

function hasDefinedRow<T>(rows: Array<T | undefined>) {
	return rows.some((row) => row !== undefined);
}

function hasDuplicateRowIds(rows: Array<{ id: string }>) {
	return new Set(rows.map((row) => row.id)).size !== rows.length;
}

async function trackIncompleteSessionCreation(
	operation: AuthenticatedDatabaseOperation,
	error: SessionCreationCompensationError
) {
	persistEditingCompensation(
		error,
		'session-creation',
		error.attempt.userId,
		getOwnedSessionOperationKey(error.attempt.userId, error.attempt.sessionId),
		error.attempt.sessionId,
		error.attempt
	);
	await repairSessionCreationCompensationWithOperation(operation, error);

	if (error.remainingRowIds.length > 0) {
		const operationKey = getOwnedSessionOperationKey(error.attempt.userId, error.attempt.sessionId);
		const pendingCompensations = pendingSessionCreationCompensations.get(operationKey) ?? new Set();
		pendingCompensations.add(error);
		pendingSessionCreationCompensations.set(operationKey, pendingCompensations);
	}
}

function rowsExactlyMatch<T extends { id: string }>(currentRows: T[], expectedRows: T[]) {
	if (currentRows.length !== expectedRows.length) {
		return false;
	}

	const currentRowById = new Map(currentRows.map((row) => [row.id, row]));

	return expectedRows.every((expectedRow) => {
		const currentRow = currentRowById.get(expectedRow.id);

		if (!currentRow) {
			return false;
		}

		const keys = new Set([...Object.keys(currentRow), ...Object.keys(expectedRow)]);

		return [...keys].every(
			(key) =>
				(currentRow as unknown as Record<string, unknown>)[key] ===
				(expectedRow as unknown as Record<string, unknown>)[key]
		);
	});
}

function rowExactlyMatches<T extends { id: string }>(currentRow: T, expectedRow: T) {
	return rowsExactlyMatch([currentRow], [expectedRow]);
}

function createSessionSetEditMutation(
	before: SessionSet | undefined,
	after: SessionSet | undefined
): SessionEditCompensationMutation {
	return {
		table: 'sessionSets',
		id: (after ?? before)!.id,
		before: before ? structuredClone(before) : undefined,
		after: after ? structuredClone(after) : undefined
	};
}

function createSessionExerciseEditMutation(
	before: SessionExercise | undefined,
	after: SessionExercise | undefined
): SessionEditCompensationMutation {
	return {
		table: 'sessionExercises',
		id: (after ?? before)!.id,
		before: before ? structuredClone(before) : undefined,
		after: after ? structuredClone(after) : undefined
	};
}

function createWorkoutSessionEditMutation(
	before: WorkoutSession | undefined,
	after: WorkoutSession | undefined
): SessionEditCompensationMutation {
	return {
		table: 'workoutSessions',
		id: (after ?? before)!.id,
		before: before ? structuredClone(before) : undefined,
		after: after ? structuredClone(after) : undefined
	};
}

function buildSessionSetEditMutations(beforeRows: SessionSet[], afterRows: SessionSet[]) {
	const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
	const afterById = new Map(afterRows.map((row) => [row.id, row]));
	const rowIds = [...new Set([...afterById.keys(), ...beforeById.keys()])];

	return rowIds
		.map((id) => createSessionSetEditMutation(beforeById.get(id), afterById.get(id)))
		.filter(
			(mutation) =>
				!mutation.before || !mutation.after || !rowExactlyMatches(mutation.before, mutation.after)
		);
}

function buildSessionExerciseEditMutations(
	beforeRows: SessionExercise[],
	afterRows: SessionExercise[]
) {
	const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
	const afterById = new Map(afterRows.map((row) => [row.id, row]));
	const rowIds = [...new Set([...afterById.keys(), ...beforeById.keys()])];

	return rowIds
		.map((id) => createSessionExerciseEditMutation(beforeById.get(id), afterById.get(id)))
		.filter(
			(mutation) =>
				!mutation.before || !mutation.after || !rowExactlyMatches(mutation.before, mutation.after)
		);
}

async function getSessionEditMutationState(
	database: SessionEditingDatabase,
	mutation: SessionEditCompensationMutation
): Promise<'before' | 'after' | 'concurrent'> {
	switch (mutation.table) {
		case 'sessionSets': {
			const stored = await database.sessionSets.get(mutation.id);

			if (mutation.before && stored && rowExactlyMatches(stored, mutation.before)) {
				return 'before';
			}
			if (mutation.after && stored && rowExactlyMatches(stored, mutation.after)) {
				return 'after';
			}
			if (!mutation.before && !stored) {
				return 'before';
			}
			if (!mutation.after && !stored) {
				return 'after';
			}
			return 'concurrent';
		}
		case 'sessionExercises': {
			const stored = await database.sessionExercises.get(mutation.id);

			if (mutation.before && stored && rowExactlyMatches(stored, mutation.before)) {
				return 'before';
			}
			if (mutation.after && stored && rowExactlyMatches(stored, mutation.after)) {
				return 'after';
			}
			if (!mutation.before && !stored) {
				return 'before';
			}
			if (!mutation.after && !stored) {
				return 'after';
			}
			return 'concurrent';
		}
		case 'workoutSessions': {
			const stored = await database.workoutSessions.get(mutation.id);

			if (mutation.before && stored && rowExactlyMatches(stored, mutation.before)) {
				return 'before';
			}
			if (mutation.after && stored && rowExactlyMatches(stored, mutation.after)) {
				return 'after';
			}
			if (!mutation.before && !stored) {
				return 'before';
			}
			if (!mutation.after && !stored) {
				return 'after';
			}
			return 'concurrent';
		}
	}
}

async function sessionEditMutationNeedsRepair(
	database: SessionEditingDatabase,
	mutation: SessionEditCompensationMutation
) {
	return (await getSessionEditMutationState(database, mutation)) === 'after';
}

async function restoreSessionEditMutation(
	database: SessionEditingDatabase,
	mutation: SessionEditCompensationMutation
) {
	switch (mutation.table) {
		case 'sessionSets':
			if (mutation.before) {
				await database.sessionSets.put(mutation.before);
			} else {
				await database.sessionSets.delete(mutation.id);
			}
			return;
		case 'sessionExercises':
			if (mutation.before) {
				await database.sessionExercises.put(mutation.before);
			} else {
				await database.sessionExercises.delete(mutation.id);
			}
			return;
		case 'workoutSessions':
			if (mutation.before) {
				await database.workoutSessions.put(mutation.before);
			} else {
				await database.workoutSessions.delete(mutation.id);
			}
	}
}

async function compensateFailedSessionEdit(
	database: SessionEditingDatabase,
	attempt: SessionEditCompensationAttempt
): Promise<SessionEditCompensationReport> {
	const cleanupErrors: unknown[] = [];
	const initialMutationStates: Array<'before' | 'after' | 'concurrent'> = [];

	for (const mutation of attempt.mutations) {
		try {
			initialMutationStates.push(await getSessionEditMutationState(database, mutation));
		} catch (error) {
			cleanupErrors.push(
				new Error(`Failed to inspect ${mutation.table} row ${mutation.id} before repair.`, {
					cause: error
				})
			);
			return {
				cleanupErrors,
				remainingRowIds: [...new Set(attempt.mutations.map(({ id }) => id))]
			};
		}
	}

	if (initialMutationStates.includes('concurrent')) {
		// A newer edit now owns at least one exact graph row. Do not mix an old rollback into that
		// winner's graph; the old failed state is no longer exclusively attributable to this attempt.
		return { cleanupErrors, remainingRowIds: [] };
	}

	for (let index = 0; index < attempt.mutations.length; index += 1) {
		const mutation = attempt.mutations[index];

		try {
			if (
				initialMutationStates[index] === 'after' &&
				(await sessionEditMutationNeedsRepair(database, mutation))
			) {
				await restoreSessionEditMutation(database, mutation);
			}
		} catch (error) {
			cleanupErrors.push(
				new Error(`Failed to restore ${mutation.table} row ${mutation.id}.`, { cause: error })
			);
		}
	}

	const remainingRowIds: string[] = [];

	for (const mutation of attempt.mutations) {
		try {
			if (await sessionEditMutationNeedsRepair(database, mutation)) {
				remainingRowIds.push(mutation.id);
			}
		} catch (error) {
			remainingRowIds.push(mutation.id);
			cleanupErrors.push(
				new Error(`Failed to verify restored ${mutation.table} row ${mutation.id}.`, {
					cause: error
				})
			);
		}
	}

	return {
		cleanupErrors,
		remainingRowIds: [...new Set(remainingRowIds)]
	};
}

function trackIncompleteSessionEdit(error: SessionEditCompensationError) {
	if (error.remainingRowIds.length === 0) {
		return;
	}

	persistEditingCompensation(
		error,
		'session-edit',
		error.attempt.userId,
		getSessionEditJournalOperationKey(error.attempt),
		error.attempt.sessionId ?? `orphan:${error.attempt.scopeKeys[0]}`,
		error.attempt
	);
	const pendingCompensations =
		pendingSessionEditCompensations.get(error.attempt.userId) ?? new Set();
	pendingCompensations.add(error);
	pendingSessionEditCompensations.set(error.attempt.userId, pendingCompensations);
}

async function repairSessionEditCompensationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	error: SessionEditCompensationError
) {
	requireCompensationOwner(operation, error.attempt);
	const report = await compensateFailedSessionEdit(operation.database, error.attempt);
	error.cleanupErrors.push(...report.cleanupErrors);
	error.remainingRowIds = report.remainingRowIds;

	if (error.remainingRowIds.length === 0) {
		removeEditingCompensationJournal(error);
		const pendingCompensations = pendingSessionEditCompensations.get(error.attempt.userId);
		pendingCompensations?.delete(error);

		if (pendingCompensations?.size === 0) {
			pendingSessionEditCompensations.delete(error.attempt.userId);
		}
	}

	return error.remainingRowIds.length === 0;
}

export async function repairSessionEditCompensation(error: SessionEditCompensationError) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		repairSessionEditCompensationWithOperation(operation, error)
	);
}

async function repairPendingSessionEditCompensation(
	operation: AuthenticatedDatabaseOperation,
	scopeKey: string
) {
	let pendingCompensations = pendingSessionEditCompensations.get(operation.userId);

	if (!pendingCompensations) {
		try {
			const hydratedErrors = readCompensationJournalEntries({
				userId: operation.userId,
				kind: 'session-edit',
				validatePayload: isSessionEditCompensationAttempt
			}).flatMap((entry) => {
				if (entry.payload.userId !== operation.userId) {
					return [];
				}

				const error = new SessionEditCompensationError(
					new Error('Recovered an interrupted session edit repair from durable storage.'),
					[],
					entry.payload.mutations.map(({ id }) => id),
					entry.payload
				);
				error.journalEntry = entry;
				return [error];
			});

			if (hydratedErrors.length > 0) {
				pendingCompensations = new Set(hydratedErrors);
				pendingSessionEditCompensations.set(operation.userId, pendingCompensations);
			}
		} catch {
			// A subsequent incomplete repair will surface an explicit non-durable warning.
		}
	}

	if (!pendingCompensations) {
		return;
	}

	for (const pendingCompensation of [...pendingCompensations]) {
		if (!pendingCompensation.attempt.scopeKeys.includes(scopeKey)) {
			continue;
		}

		await repairSessionEditCompensationWithOperation(operation, pendingCompensation);
	}

	const stillPending = [...(pendingSessionEditCompensations.get(operation.userId) ?? [])].find(
		(pendingCompensation) => pendingCompensation.attempt.scopeKeys.includes(scopeKey)
	);

	if (stillPending) {
		throw stillPending;
	}
}

async function compensateFailedSessionReorder(
	database: SessionEditingDatabase,
	attempt: SessionReorderCompensationAttempt
): Promise<SessionReorderCompensationReport> {
	const cleanupErrors: unknown[] = [];

	async function attemptCleanup(label: string, callback: () => Promise<unknown>) {
		try {
			await callback();
		} catch (error) {
			cleanupErrors.push(new Error(label, { cause: error }));
		}
	}

	for (let index = 0; index < attempt.afterSessionExercises.length; index += 1) {
		const afterRow = attempt.afterSessionExercises[index];
		const beforeRow = attempt.beforeSessionExercises[index];

		await attemptCleanup(`Failed to restore reordered exercise ${afterRow.id}.`, async () => {
			const currentRow = await database.sessionExercises.get(afterRow.id);

			if (currentRow && rowExactlyMatches(currentRow, afterRow)) {
				await database.sessionExercises.put(beforeRow);
			}
		});
	}

	await attemptCleanup('Failed to restore reordered session metadata.', async () => {
		const currentSession = await database.workoutSessions.get(attempt.sessionId);

		if (currentSession && rowExactlyMatches(currentSession, attempt.sessionMetadata.after)) {
			await database.workoutSessions.put(attempt.sessionMetadata.before);
		}
	});

	let remainingRowIds = [
		...attempt.afterSessionExercises.map((sessionExercise) => sessionExercise.id),
		attempt.sessionId
	];

	try {
		const [storedSessionExercises, storedSession] = await Promise.all([
			database.sessionExercises.bulkGet(
				attempt.afterSessionExercises.map((sessionExercise) => sessionExercise.id)
			),
			database.workoutSessions.get(attempt.sessionId)
		]);
		remainingRowIds = [
			...storedSessionExercises.flatMap((storedRow, index) =>
				storedRow && rowExactlyMatches(storedRow, attempt.afterSessionExercises[index])
					? [storedRow.id]
					: []
			),
			...(storedSession && rowExactlyMatches(storedSession, attempt.sessionMetadata.after)
				? [storedSession.id]
				: [])
		];
	} catch (error) {
		cleanupErrors.push(
			new Error('Failed to verify that temporary reorder changes were restored.', {
				cause: error
			})
		);
	}

	return { cleanupErrors, remainingRowIds: [...new Set(remainingRowIds)] };
}

async function repairSessionReorderCompensationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	error: SessionReorderCompensationError
) {
	requireCompensationOwner(operation, error.attempt);
	const report = await compensateFailedSessionReorder(operation.database, error.attempt);
	error.cleanupErrors.push(...report.cleanupErrors);
	error.remainingRowIds = report.remainingRowIds;

	if (error.remainingRowIds.length === 0) {
		removeEditingCompensationJournal(error);
		const operationKey = getOwnedSessionOperationKey(error.attempt.userId, error.attempt.sessionId);
		const pendingCompensations = pendingSessionReorderCompensations.get(operationKey);
		pendingCompensations?.delete(error);

		if (pendingCompensations?.size === 0) {
			pendingSessionReorderCompensations.delete(operationKey);
		}
	}

	return error.remainingRowIds.length === 0;
}

export async function repairSessionReorderCompensation(error: SessionReorderCompensationError) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		repairSessionReorderCompensationWithOperation(operation, error)
	);
}

async function repairPendingSessionReorderCompensation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string
) {
	const operationKey = getOwnedSessionOperationKey(operation.userId, sessionId);
	let pendingCompensations = pendingSessionReorderCompensations.get(operationKey);

	if (!pendingCompensations) {
		try {
			const hydratedErrors = readCompensationJournalEntries({
				userId: operation.userId,
				kind: 'session-reorder',
				operationKey,
				validatePayload: isSessionReorderCompensationAttempt
			}).flatMap((entry) => {
				if (entry.payload.userId !== operation.userId || entry.payload.sessionId !== sessionId) {
					return [];
				}

				const error = new SessionReorderCompensationError(
					new Error('Recovered an interrupted session reorder repair from durable storage.'),
					[],
					[...entry.payload.afterSessionExercises.map(({ id }) => id), entry.payload.sessionId],
					entry.payload
				);
				error.journalEntry = entry;
				return [error];
			});

			if (hydratedErrors.length > 0) {
				pendingCompensations = new Set(hydratedErrors);
				pendingSessionReorderCompensations.set(operationKey, pendingCompensations);
			}
		} catch {
			// A subsequent incomplete repair will surface an explicit non-durable warning.
		}
	}

	if (!pendingCompensations) {
		return;
	}

	for (const pendingCompensation of [...pendingCompensations]) {
		await repairSessionReorderCompensationWithOperation(operation, pendingCompensation);
	}

	const stillPending = pendingSessionReorderCompensations.get(operationKey);

	if (stillPending && stillPending.size > 0) {
		throw stillPending.values().next().value;
	}
}

async function throwAfterSessionReorderCompensation(
	database: SessionEditingDatabase,
	originalError: unknown,
	attempt: SessionReorderCompensationAttempt
): Promise<never> {
	const report = await compensateFailedSessionReorder(database, attempt);

	if (report.cleanupErrors.length > 0 || report.remainingRowIds.length > 0) {
		throw new SessionReorderCompensationError(
			originalError,
			report.cleanupErrors,
			report.remainingRowIds,
			attempt
		);
	}

	throw originalError;
}

function trackIncompleteSessionReorder(error: SessionReorderCompensationError) {
	if (error.remainingRowIds.length === 0) {
		return;
	}

	const operationKey = getOwnedSessionOperationKey(error.attempt.userId, error.attempt.sessionId);
	persistEditingCompensation(
		error,
		'session-reorder',
		error.attempt.userId,
		operationKey,
		error.attempt.sessionId,
		error.attempt
	);
	const pendingCompensations = pendingSessionReorderCompensations.get(operationKey) ?? new Set();
	pendingCompensations.add(error);
	pendingSessionReorderCompensations.set(operationKey, pendingCompensations);
}

function requireExpectedDestructiveEdit(
	userId: string,
	sessionId: string,
	currentSessionExercises: SessionExercise[],
	currentSessionSets: SessionSet[],
	expectation: SessionDestructiveEditExpectation
) {
	if (
		expectation.sessionId !== sessionId ||
		!rowsExactlyMatch(currentSessionExercises, expectation.sessionExercises) ||
		!rowsExactlyMatch(currentSessionSets, expectation.sessionSets) ||
		!sessionInputDraftVersionSnapshotMatches(expectation.inputDraft, userId)
	) {
		throw new Error(
			'This session changed in another tab. Reload and review the latest values before trying again.'
		);
	}
}

async function captureSessionExerciseDestructiveEditExpectationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionExerciseId: string,
	options: { activeSetsOnly?: boolean } = {}
): Promise<SessionDestructiveEditExpectation> {
	const { database, userId } = operation;
	const sessionExercise = await database.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const storedSessionSets = await database.sessionSets
		.where('sessionExerciseId')
		.equals(sessionExerciseId)
		.toArray();
	const sessionSets = options.activeSetsOnly
		? storedSessionSets.filter((sessionSet) =>
				sessionSetMatchesSessionExercise(sessionSet, sessionExercise)
			)
		: storedSessionSets;

	return {
		sessionId: sessionExercise.sessionId,
		sessionExercises: [sessionExercise],
		sessionSets,
		inputDraft: captureSessionInputDraftVersionSnapshot(
			sessionExercise.sessionId,
			sessionSets.map((sessionSet) => sessionSet.id),
			userId
		)
	};
}

export async function captureSessionExerciseDestructiveEditExpectation(
	sessionExerciseId: string,
	options: { activeSetsOnly?: boolean } = {}
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		captureSessionExerciseDestructiveEditExpectationWithOperation(
			operation,
			sessionExerciseId,
			options
		)
	);
}

async function captureSessionSetRemovalExpectationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionSetId: string
): Promise<SessionDestructiveEditExpectation> {
	const { database, userId } = operation;
	const sessionSet = await database.sessionSets.get(sessionSetId);

	if (!sessionSet) {
		throw new Error('Set not found in this session.');
	}

	const sessionExercise = await database.sessionExercises.get(sessionSet.sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const currentSets = (
		await database.sessionSets.where('sessionExerciseId').equals(sessionExercise.id).toArray()
	).filter((currentSet) => sessionSetMatchesSessionExercise(currentSet, sessionExercise));
	const logicalSets = groupSessionSetRows(currentSets).find((rows) =>
		rows.some((currentSet) => currentSet.id === sessionSet.id)
	) ?? [sessionSet];

	return {
		sessionId: sessionExercise.sessionId,
		sessionExercises: [sessionExercise],
		sessionSets: logicalSets,
		inputDraft: captureSessionInputDraftVersionSnapshot(
			sessionExercise.sessionId,
			logicalSets.map((logicalSet) => logicalSet.id),
			userId
		)
	};
}

export async function captureSessionSetRemovalExpectation(sessionSetId: string) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		captureSessionSetRemovalExpectationWithOperation(operation, sessionSetId)
	);
}

async function captureSessionResetExpectationWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string
): Promise<SessionDestructiveEditExpectation> {
	const { database, userId } = operation;
	const session = await database.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	const sessionExercises = await database.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length > 0
			? await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()
			: [];

	return {
		sessionId,
		sessionExercises,
		sessionSets,
		inputDraft: captureSessionInputDraftVersionSnapshot(sessionId, undefined, userId)
	};
}

export async function captureSessionResetExpectation(sessionId: string) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		captureSessionResetExpectationWithOperation(operation, sessionId)
	);
}

function requireExpectedStructuralEdit(
	session: Pick<WorkoutSession, 'status'>,
	expectation: SessionStructuralEditExpectation
) {
	if (session.status === 'abandoned' || expectation.status === 'abandoned') {
		throw new Error('Abandoned sessions cannot be structurally edited.');
	}

	if (session.status !== expectation.status) {
		throw new Error('Session status changed in another tab. Reload before editing.');
	}

	if (session.status === 'completed' && !expectation.allowCompleted) {
		throw new Error('Completed sessions can only be changed from completed-session edit mode.');
	}
}

function getNextRowUpdatedAt(
	row: Pick<SessionExercise, 'createdAt' | 'updatedAt'>,
	now = timestamp()
) {
	const createdAtMs = new Date(row.createdAt).getTime();
	const updatedAtMs = new Date(row.updatedAt).getTime();
	const nowMs = new Date(now).getTime();

	if (![createdAtMs, updatedAtMs, nowMs].every(Number.isFinite)) {
		return now;
	}

	return timestamp(new Date(Math.max(nowMs, createdAtMs + 1, updatedAtMs + 1)));
}

export async function reorderSessionExercises(
	sessionId: string,
	orderedSessionExerciseIds: string[],
	expectation: SessionStructuralEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		reorderSessionExercisesWithOperation(
			operation,
			sessionId,
			orderedSessionExerciseIds,
			expectation
		)
	);
}

async function reorderSessionExercisesWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string,
	orderedSessionExerciseIds: string[],
	expectation: SessionStructuralEditExpectation
) {
	const { database, userId } = operation;
	await repairPendingSessionReorderCompensation(operation, sessionId);

	try {
		await database.transaction(
			'rw',
			database.sessionExercises,
			database.workoutSessions,
			async () => {
				const currentSession = await database.workoutSessions.get(sessionId);

				if (!currentSession) {
					throw new Error('Session not found.');
				}

				requireExpectedStructuralEdit(currentSession, expectation);
				const beforeSessionExercises = await database.sessionExercises
					.where('sessionId')
					.equals(sessionId)
					.toArray();
				const sortedSessionExercises = [...beforeSessionExercises].sort(compareSessionExerciseRows);
				const currentIds = sortedSessionExercises.map((sessionExercise) => sessionExercise.id);
				const currentIdSet = new Set(currentIds);
				const requestedIdSet = new Set<string>();
				const orderedIds = orderedSessionExerciseIds.filter((id) => {
					if (!currentIdSet.has(id) || requestedIdSet.has(id)) {
						return false;
					}

					requestedIdSet.add(id);
					return true;
				});
				let orderedIdIndex = 0;
				const nextIds = currentIds.map((currentId) => {
					if (!requestedIdSet.has(currentId)) {
						return currentId;
					}

					const nextId = orderedIds[orderedIdIndex] ?? currentId;
					orderedIdIndex += 1;
					return nextId;
				});
				const attemptUpdatedAt = [currentSession, ...beforeSessionExercises].reduce(
					(nextUpdatedAt, row) => getNextRowUpdatedAt(row, nextUpdatedAt),
					timestamp()
				);
				const beforeSessionExerciseById = new Map(
					beforeSessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
				);
				const afterSessionExercises = nextIds.map((id, index) => ({
					...beforeSessionExerciseById.get(id)!,
					order: index + 1,
					updatedAt: attemptUpdatedAt
				}));
				const attempt: SessionReorderCompensationAttempt = {
					userId,
					sessionId,
					beforeSessionExercises: afterSessionExercises.map(
						(afterRow) => beforeSessionExerciseById.get(afterRow.id)!
					),
					afterSessionExercises,
					sessionMetadata: {
						before: currentSession,
						after: { ...currentSession, updatedAt: attemptUpdatedAt }
					}
				};

				try {
					for (const afterRow of afterSessionExercises) {
						await requireRowUpdate(
							database.sessionExercises.update(afterRow.id, {
								order: afterRow.order,
								updatedAt: afterRow.updatedAt
							}),
							'An exercise disappeared while the session was being reordered.'
						);
					}

					await requireRowUpdate(
						database.workoutSessions.update(sessionId, { updatedAt: attemptUpdatedAt }),
						'Session disappeared while its exercises were being reordered.'
					);
				} catch (error) {
					return throwAfterSessionReorderCompensation(database, error, attempt);
				}
			}
		);
	} catch (error) {
		if (error instanceof SessionReorderCompensationError) {
			trackIncompleteSessionReorder(error);
		}

		throw error;
	}
}

export async function replaceSessionExercise(
	sessionExerciseId: string,
	exerciseId: string,
	expectation: SessionStructuralEditExpectation,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		replaceSessionExerciseWithOperation(
			operation,
			sessionExerciseId,
			exerciseId,
			expectation,
			destructiveExpectation
		)
	);
}

async function replaceSessionExerciseWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionExerciseId: string,
	exerciseId: string,
	expectation: SessionStructuralEditExpectation,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	const { database, userId } = operation;
	await repairPendingSessionEditCompensation(
		operation,
		getSessionEditExerciseScopeKey(sessionExerciseId)
	);
	const initiatingExpectation =
		destructiveExpectation ??
		(await captureSessionExerciseDestructiveEditExpectationWithOperation(
			operation,
			sessionExerciseId,
			{
				activeSetsOnly: true
			}
		));

	const sessionExercise = await database.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const [session, exercise, sessionExercises] = await Promise.all([
		database.workoutSessions.get(sessionExercise.sessionId),
		getExercise(exerciseId, database),
		database.sessionExercises.where('sessionId').equals(sessionExercise.sessionId).toArray()
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	if (
		sessionExercises.some(
			(candidate) => candidate.id !== sessionExerciseId && candidate.exerciseId === exerciseId
		)
	) {
		throw new Error('That exercise is already in this session.');
	}

	const now = timestamp();
	const seedSets = await buildSessionSeedSetRows(
		sessionExerciseId,
		exercise,
		now,
		session.id,
		(order) => getSessionExerciseSeedSetLogicalId(sessionExerciseId, exercise.id, order),
		database
	);
	let deletedSetIds: string[] = [];
	let draftSessionId: string | undefined;

	await database.transaction(
		'rw',
		database.sessionExercises,
		database.sessionSets,
		database.workoutSessions,
		async () => {
			const currentSessionExercise = await database.sessionExercises.get(sessionExerciseId);
			const currentSession = await database.workoutSessions.get(session.id);

			if (!currentSessionExercise || currentSessionExercise.sessionId !== session.id) {
				throw new Error('Exercise not found in this session.');
			}

			if (!currentSession) {
				throw new Error('Session not found.');
			}

			requireExpectedStructuralEdit(currentSession, expectation);

			const duplicateExercise = (
				await database.sessionExercises.where('sessionId').equals(session.id).toArray()
			).some(
				(candidate) => candidate.id !== sessionExerciseId && candidate.exerciseId === exerciseId
			);

			if (duplicateExercise) {
				throw new Error('That exercise is already in this session.');
			}

			const storedSets = await database.sessionSets
				.where('sessionExerciseId')
				.equals(sessionExerciseId)
				.toArray();
			const currentSets = storedSets.filter((sessionSet) =>
				sessionSetMatchesSessionExercise(sessionSet, currentSessionExercise)
			);
			requireExpectedDestructiveEdit(
				userId,
				currentSession.id,
				[currentSessionExercise],
				currentSets,
				initiatingExpectation
			);
			deletedSetIds = currentSets.map((sessionSet) => sessionSet.id);
			draftSessionId = currentSessionExercise.sessionId;
			const storedSetById = new Map(storedSets.map((sessionSet) => [sessionSet.id, sessionSet]));
			const nextSeedSets = seedSets.map((seedSet) => {
				const storedSet = storedSetById.get(seedSet.id);

				return storedSet
					? {
							...seedSet,
							createdAt: storedSet.createdAt,
							updatedAt: getNextRowUpdatedAt(storedSet, now)
						}
					: seedSet;
			});
			const seedSetIds = nextSeedSets.map((sessionSet) => sessionSet.id);
			const seedSetIdSet = new Set(seedSetIds);
			const obsoleteSetIds = deletedSetIds.filter((id) => !seedSetIdSet.has(id));
			const intendedSetById = new Map(storedSets.map((sessionSet) => [sessionSet.id, sessionSet]));

			for (const seedSet of nextSeedSets) {
				intendedSetById.set(seedSet.id, seedSet);
			}

			for (const obsoleteSetId of obsoleteSetIds) {
				intendedSetById.delete(obsoleteSetId);
			}

			const nextSessionExercise: SessionExercise = {
				...currentSessionExercise,
				exerciseId: exercise.id,
				exerciseNameSnapshot: exercise.name,
				updatedAt: getNextRowUpdatedAt(currentSessionExercise, now)
			};
			const nextSession: WorkoutSession = {
				...currentSession,
				updatedAt: getNextRowUpdatedAt(currentSession, now)
			};
			const compensationAttempt: SessionEditCompensationAttempt = {
				userId,
				operation: 'Exercise replacement',
				sessionId: currentSession.id,
				scopeKeys: [
					getSessionEditExerciseScopeKey(sessionExerciseId),
					getSessionEditSessionScopeKey(currentSession.id)
				],
				mutations: [
					...buildSessionSetEditMutations(storedSets, [...intendedSetById.values()]),
					createSessionExerciseEditMutation(currentSessionExercise, nextSessionExercise),
					createWorkoutSessionEditMutation(currentSession, nextSession)
				]
			};

			try {
				if (nextSeedSets.length > 0) {
					// Replacement ids are deterministic. Upsert lets a retry or a later switch back to the
					// same exercise reuse its hidden branch rows without creating duplicate logical sets.
					await database.sessionSets.bulkPut(nextSeedSets);
				}

				await requireRowUpdate(
					database.sessionExercises.update(sessionExerciseId, {
						exerciseId: exercise.id,
						exerciseNameSnapshot: exercise.name,
						updatedAt: nextSessionExercise.updatedAt
					}),
					'Exercise disappeared while it was being replaced.'
				);

				if (obsoleteSetIds.length > 0) {
					await database.sessionSets.bulkDelete(obsoleteSetIds);
				}

				await requireRowUpdate(
					database.workoutSessions.update(session.id, {
						updatedAt: nextSession.updatedAt
					}),
					'Session disappeared while its exercise was being replaced.'
				);
			} catch (error) {
				return compensateSessionEdit(database, error, compensationAttempt);
			}
		}
	);

	if (draftSessionId) {
		finalizeSessionInputDraftSetsIfUnchanged(
			initiatingExpectation.inputDraft,
			deletedSetIds,
			userId
		);
	}
}

export async function removeSessionExercise(
	sessionExerciseId: string,
	expectation: SessionStructuralEditExpectation,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		removeSessionExerciseWithOperation(
			operation,
			sessionExerciseId,
			expectation,
			destructiveExpectation
		)
	);
}

async function removeSessionExerciseWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionExerciseId: string,
	expectation: SessionStructuralEditExpectation,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	const { database, userId } = operation;
	await repairPendingSessionEditCompensation(
		operation,
		getSessionEditExerciseScopeKey(sessionExerciseId)
	);
	const initiatingExpectation =
		destructiveExpectation ??
		(await captureSessionExerciseDestructiveEditExpectationWithOperation(
			operation,
			sessionExerciseId
		));

	let deletedSetIds: string[] = [];
	let draftSessionId: string | undefined;

	await database.transaction(
		'rw',
		database.sessionExercises,
		database.sessionSets,
		database.workoutSessions,
		async () => {
			const sessionExercise = await database.sessionExercises.get(sessionExerciseId);

			if (!sessionExercise) {
				throw new Error(
					'This session changed in another tab. Reload and review the latest values before trying again.'
				);
			}
			const currentSession = await database.workoutSessions.get(sessionExercise.sessionId);

			if (!currentSession) {
				throw new Error('Session not found.');
			}

			requireExpectedStructuralEdit(currentSession, expectation);

			const [currentSets, currentSessionExercises] = await Promise.all([
				database.sessionSets.where('sessionExerciseId').equals(sessionExerciseId).toArray(),
				database.sessionExercises.where('sessionId').equals(sessionExercise.sessionId).toArray()
			]);
			requireExpectedDestructiveEdit(
				userId,
				currentSession.id,
				[sessionExercise],
				currentSets,
				initiatingExpectation
			);
			deletedSetIds = currentSets.map((sessionSet) => sessionSet.id);
			draftSessionId = sessionExercise.sessionId;
			const remainingSessionExercises = reconcileSessionExerciseOrderCollisions(
				currentSessionExercises.filter((candidate) => candidate.id !== sessionExerciseId)
			);
			const now = timestamp();
			const sessionUpdatedAt = getNextRowUpdatedAt(currentSession, now);
			const nextSessionExercises = remainingSessionExercises.map(
				(remainingSessionExercise, index) => ({
					...remainingSessionExercise,
					order: index + 1,
					updatedAt: getNextRowUpdatedAt(remainingSessionExercise, now)
				})
			);
			const nextSession: WorkoutSession = {
				...currentSession,
				updatedAt: sessionUpdatedAt
			};
			const compensationAttempt: SessionEditCompensationAttempt = {
				userId,
				operation: 'Exercise removal',
				sessionId: currentSession.id,
				scopeKeys: [
					getSessionEditExerciseScopeKey(sessionExerciseId),
					getSessionEditSessionScopeKey(currentSession.id)
				],
				mutations: [
					...buildSessionExerciseEditMutations(currentSessionExercises, nextSessionExercises),
					...buildSessionSetEditMutations(currentSets, []),
					createWorkoutSessionEditMutation(currentSession, nextSession)
				]
			};

			try {
				await Promise.all(
					nextSessionExercises.map((nextSessionExercise) =>
						requireRowUpdate(
							database.sessionExercises.update(nextSessionExercise.id, {
								order: nextSessionExercise.order,
								updatedAt: nextSessionExercise.updatedAt
							}),
							'An exercise disappeared while the session was being reordered.'
						)
					)
				);

				await database.sessionExercises.delete(sessionExerciseId);

				if (currentSets.length > 0) {
					await database.sessionSets.bulkDelete(deletedSetIds);
				}

				await requireRowUpdate(
					database.workoutSessions.update(sessionExercise.sessionId, {
						updatedAt: sessionUpdatedAt
					}),
					'Session disappeared while its exercise was being removed.'
				);
			} catch (error) {
				return compensateSessionEdit(database, error, compensationAttempt);
			}
		}
	);

	if (draftSessionId) {
		finalizeSessionInputDraftSetsIfUnchanged(
			initiatingExpectation.inputDraft,
			deletedSetIds,
			userId
		);
	}
}

export async function addExerciseToSession(
	sessionId: string,
	exerciseId: string,
	expectation: SessionStructuralEditExpectation
) {
	requireLoggedInUser();
	const [sessionExercise] = await runAuthenticatedDatabaseOperation((operation) =>
		addExercisesToSessionWithOperation(operation, sessionId, [exerciseId], expectation)
	);

	return sessionExercise;
}

export async function addExercisesToSession(
	sessionId: string,
	exerciseIds: string[],
	expectation: SessionStructuralEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		addExercisesToSessionWithOperation(operation, sessionId, exerciseIds, expectation)
	);
}

async function addExercisesToSessionWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string,
	exerciseIds: string[],
	expectation: SessionStructuralEditExpectation
) {
	const { database, userId } = operation;
	const uniqueExerciseIds = [...new Set(exerciseIds)];

	if (uniqueExerciseIds.length === 0) {
		return [];
	}

	await repairPendingSessionCreationCompensation(operation, sessionId);

	const [session, exercises] = await Promise.all([
		database.workoutSessions.get(sessionId),
		Promise.all(uniqueExerciseIds.map((exerciseId) => getExercise(exerciseId, database)))
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (exercises.some((exercise) => !exercise)) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	const candidateSessionExercises = exercises.map((exercise) => ({
		id: getAddedSessionExerciseId(sessionId, exercise!.id, session.updatedAt),
		exercise: exercise!,
		seedSets: [] as SessionSet[]
	}));

	await Promise.all(
		candidateSessionExercises.map(async (candidate) => {
			candidate.seedSets = await buildSessionSeedSetRows(
				candidate.id,
				candidate.exercise,
				now,
				session.id,
				(order) => getSessionExerciseSeedSetLogicalId(candidate.id, candidate.exercise.id, order),
				database
			);
		})
	);

	try {
		return await database.transaction<SessionExercise[]>(
			'rw',
			database.sessionExercises,
			database.sessionSets,
			database.workoutSessions,
			async () => {
				const currentSession = await database.workoutSessions.get(sessionId);

				if (!currentSession) {
					throw new Error('Session not found.');
				}

				requireExpectedStructuralEdit(currentSession, expectation);

				if (currentSession.updatedAt !== session.updatedAt) {
					throw new Error(
						'This session changed while exercises were being prepared. Try adding them again.'
					);
				}

				const existingSessionExercises = await database.sessionExercises
					.where('sessionId')
					.equals(sessionId)
					.toArray();
				const existingExerciseIds = new Set(
					existingSessionExercises.map((sessionExercise) => sessionExercise.exerciseId)
				);

				if (
					candidateSessionExercises.some((candidate) =>
						existingExerciseIds.has(candidate.exercise.id)
					)
				) {
					throw new Error('That exercise is already in this session.');
				}

				let nextOrder =
					existingSessionExercises.reduce(
						(highestOrder, currentSessionExercise) =>
							Math.max(highestOrder, currentSessionExercise.order),
						0
					) + 1;
				const sessionExercises = candidateSessionExercises.map((candidate) => ({
					id: candidate.id,
					sessionId,
					workoutId: currentSession.workoutId,
					exerciseId: candidate.exercise.id,
					exerciseNameSnapshot: candidate.exercise.name,
					order: nextOrder++,
					performedAt: currentSession.startedAt ?? now,
					createdAt: now,
					updatedAt: now
				})) satisfies SessionExercise[];
				const seedSets = candidateSessionExercises.flatMap((candidate) => candidate.seedSets);
				const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
				const seedSetIds = seedSets.map((sessionSet) => sessionSet.id);
				const [sessionExerciseSyncStates, seedSetSyncStates] = await Promise.all([
					Promise.all(
						sessionExerciseIds.map((sessionExerciseId) =>
							database.sessionExercises.getSyncState(sessionExerciseId)
						)
					),
					Promise.all(seedSetIds.map((seedSetId) => database.sessionSets.getSyncState(seedSetId)))
				]);

				if (
					hasDuplicateRowIds(sessionExercises) ||
					hasDuplicateRowIds(seedSets) ||
					sessionExerciseSyncStates.some((state) => state && !state.deleted) ||
					seedSetSyncStates.some((state) => state && !state.deleted)
				) {
					throw new Error('Could not add exercises because a generated row ID already exists.');
				}
				const sessionExercisesToAdd = sessionExercises.filter(
					(_sessionExercise, index) => !sessionExerciseSyncStates[index]
				);
				const sessionExercisesToRestore = sessionExercises.filter(
					(_sessionExercise, index) => sessionExerciseSyncStates[index]?.deleted
				);
				const seedSetsToAdd = seedSets.filter((_seedSet, index) => !seedSetSyncStates[index]);
				const seedSetsToRestore = seedSets.filter(
					(_seedSet, index) => seedSetSyncStates[index]?.deleted
				);

				const sessionUpdatedAt = getNextRowUpdatedAt(currentSession, now);
				const attempt: SessionCreationCompensationAttempt = {
					userId,
					operation: 'Exercise creation',
					sessionId,
					sessionExercises,
					sessionSets: seedSets,
					sessionMetadata: {
						before: currentSession,
						after: { ...currentSession, updatedAt: sessionUpdatedAt }
					}
				};

				try {
					if (sessionExercisesToAdd.length > 0) {
						await database.sessionExercises.bulkAdd(sessionExercisesToAdd);
					}

					if (sessionExercisesToRestore.length > 0) {
						await database.sessionExercises.bulkPut(sessionExercisesToRestore);
					}

					if (seedSetsToAdd.length > 0) {
						await database.sessionSets.bulkAdd(seedSetsToAdd);
					}

					if (seedSetsToRestore.length > 0) {
						await database.sessionSets.bulkPut(seedSetsToRestore);
					}

					await requireRowUpdate(
						database.workoutSessions.update(sessionId, { updatedAt: sessionUpdatedAt }),
						'Session disappeared while exercises were being added.'
					);
				} catch (error) {
					return throwAfterSessionCreationCompensation(database, error, attempt);
				}

				return sessionExercises;
			}
		);
	} catch (error) {
		if (error instanceof SessionCreationCompensationError) {
			await trackIncompleteSessionCreation(operation, error);
		}

		throw error;
	}
}

export async function addSessionSetRow(
	sessionExerciseId: string,
	expectation: SessionStructuralEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		addSessionSetRowWithOperation(operation, sessionExerciseId, expectation)
	);
}

async function addSessionSetRowWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionExerciseId: string,
	expectation: SessionStructuralEditExpectation
) {
	const { database, userId } = operation;
	let sessionExercise = await database.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	await repairPendingSessionCreationCompensation(operation, sessionExercise.sessionId);
	sessionExercise = await database.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const exercise = await getExercise(sessionExercise.exerciseId, database);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	let nextSets: SessionSet[] = [];

	try {
		await database.transaction(
			'rw',
			database.sessionSets,
			database.sessionExercises,
			database.workoutSessions,
			async () => {
				const currentSessionExercise = await database.sessionExercises.get(sessionExerciseId);

				if (!currentSessionExercise || currentSessionExercise.exerciseId !== exercise.id) {
					throw new Error('Exercise not found in this session.');
				}
				const currentSession = await database.workoutSessions.get(currentSessionExercise.sessionId);

				if (!currentSession) {
					throw new Error('Session not found.');
				}

				requireExpectedStructuralEdit(currentSession, expectation);

				const currentSets = (
					await database.sessionSets.where('sessionExerciseId').equals(sessionExerciseId).toArray()
				).filter((sessionSet) =>
					sessionSetMatchesSessionExercise(sessionSet, currentSessionExercise)
				);
				const nextOrder =
					currentSets.reduce(
						(highestOrder, currentSet) => Math.max(highestOrder, currentSet.order),
						0
					) + 1;
				nextSets = buildSeedSessionSetRows(
					sessionExerciseId,
					currentSessionExercise.exerciseId,
					1,
					exercise.unilateral,
					now
				).map((sessionSet) => ({
					...sessionSet,
					order: nextOrder
				}));
				const nextSetIds = nextSets.map((sessionSet) => sessionSet.id);

				if (
					hasDuplicateRowIds(nextSets) ||
					hasDefinedRow(await database.sessionSets.bulkGet(nextSetIds))
				) {
					throw new Error('Could not add the set because a generated row ID already exists.');
				}

				const sessionExerciseUpdatedAt = getNextRowUpdatedAt(currentSessionExercise, now);
				const sessionUpdatedAt = getNextRowUpdatedAt(currentSession, now);
				const attempt: SessionCreationCompensationAttempt = {
					userId,
					operation: 'Set creation',
					sessionId: currentSession.id,
					sessionExercises: [],
					sessionSets: nextSets,
					sessionExerciseMetadata: {
						before: currentSessionExercise,
						after: { ...currentSessionExercise, updatedAt: sessionExerciseUpdatedAt }
					},
					sessionMetadata: {
						before: currentSession,
						after: { ...currentSession, updatedAt: sessionUpdatedAt }
					}
				};

				try {
					await database.sessionSets.bulkAdd(nextSets);
					await requireRowUpdate(
						database.sessionExercises.update(sessionExerciseId, {
							updatedAt: sessionExerciseUpdatedAt
						}),
						'Exercise disappeared while its set was being added.'
					);
					await requireRowUpdate(
						database.workoutSessions.update(currentSessionExercise.sessionId, {
							updatedAt: sessionUpdatedAt
						}),
						'Session disappeared while its set was being added.'
					);
				} catch (error) {
					return throwAfterSessionCreationCompensation(database, error, attempt);
				}
			}
		);
	} catch (error) {
		if (error instanceof SessionCreationCompensationError) {
			await trackIncompleteSessionCreation(operation, error);
		}

		throw error;
	}

	return nextSets.map(withSessionSetDefaults).sort(compareSessionSetRows);
}

export async function removeSessionSetRow(
	sessionSetId: string,
	expectation: SessionStructuralEditExpectation,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		removeSessionSetRowWithOperation(operation, sessionSetId, expectation, destructiveExpectation)
	);
}

async function removeSessionSetRowWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionSetId: string,
	expectation: SessionStructuralEditExpectation,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	const { database, userId } = operation;
	await repairPendingSessionEditCompensation(operation, getSessionEditSetScopeKey(sessionSetId));
	let initiatingExpectation = destructiveExpectation;

	if (!initiatingExpectation) {
		const initialSessionSet = await database.sessionSets.get(sessionSetId);

		if (!initialSessionSet) {
			return;
		}

		const initialSessionExercise = await database.sessionExercises.get(
			initialSessionSet.sessionExerciseId
		);

		if (initialSessionExercise) {
			initiatingExpectation = await captureSessionSetRemovalExpectationWithOperation(
				operation,
				sessionSetId
			);
		}
	}

	let deletedSetIds: string[] = [];
	let sessionId: string | undefined;

	await database.transaction(
		'rw',
		database.sessionSets,
		database.sessionExercises,
		database.workoutSessions,
		async () => {
			const sessionSet = await database.sessionSets.get(sessionSetId);

			if (!sessionSet) {
				if (initiatingExpectation) {
					throw new Error(
						'This session changed in another tab. Reload and review the latest values before trying again.'
					);
				}

				return;
			}

			const sessionExercise = await database.sessionExercises.get(sessionSet.sessionExerciseId);

			if (!sessionExercise) {
				deletedSetIds = [sessionSet.id];
				const compensationAttempt: SessionEditCompensationAttempt = {
					userId,
					operation: 'Orphan set removal',
					sessionId: null,
					scopeKeys: [getSessionEditSetScopeKey(sessionSet.id)],
					mutations: [createSessionSetEditMutation(sessionSet, undefined)]
				};

				try {
					await database.sessionSets.delete(sessionSet.id);
				} catch (error) {
					return compensateSessionEdit(database, error, compensationAttempt);
				}
				return;
			}

			if (!sessionSetMatchesSessionExercise(sessionSet, sessionExercise)) {
				throw new Error('Set not found.');
			}
			const currentSession = await database.workoutSessions.get(sessionExercise.sessionId);

			if (!currentSession) {
				throw new Error('Session not found.');
			}

			requireExpectedStructuralEdit(currentSession, expectation);

			sessionId = sessionExercise.sessionId;
			const currentSets = (
				await database.sessionSets
					.where('sessionExerciseId')
					.equals(sessionSet.sessionExerciseId)
					.toArray()
			).filter((currentSet) => sessionSetMatchesSessionExercise(currentSet, sessionExercise));
			const deleteSetIds = groupSessionSetRows(currentSets)
				.find((rows) => rows.some((currentSet) => currentSet.id === sessionSet.id))
				?.map((currentSet) => currentSet.id) ?? [sessionSet.id];
			deletedSetIds = deleteSetIds;
			const deletedSets = currentSets.filter((currentSet) => deleteSetIds.includes(currentSet.id));

			if (!deletedSets.some((currentSet) => currentSet.id === sessionSet.id)) {
				deletedSets.push(sessionSet);
			}

			if (initiatingExpectation) {
				requireExpectedDestructiveEdit(
					userId,
					currentSession.id,
					[sessionExercise],
					deletedSets,
					initiatingExpectation
				);
			}

			const now = timestamp();
			const sessionExerciseUpdatedAt = getNextRowUpdatedAt(sessionExercise, now);
			const nextSessionExercise: SessionExercise = {
				...sessionExercise,
				updatedAt: sessionExerciseUpdatedAt
			};
			const nextSession: WorkoutSession = {
				...currentSession,
				updatedAt: getNextRowUpdatedAt(currentSession, now)
			};
			const compensationAttempt: SessionEditCompensationAttempt = {
				userId,
				operation: 'Set removal',
				sessionId: currentSession.id,
				scopeKeys: [
					getSessionEditSetScopeKey(sessionSet.id),
					getSessionEditSessionScopeKey(currentSession.id)
				],
				mutations: [
					...buildSessionSetEditMutations(deletedSets, []),
					createSessionExerciseEditMutation(sessionExercise, nextSessionExercise),
					createWorkoutSessionEditMutation(currentSession, nextSession)
				]
			};

			try {
				if (deleteSetIds.length > 0) {
					await database.sessionSets.bulkDelete(deleteSetIds);
				}

				await requireRowUpdate(
					database.sessionExercises.update(sessionExercise.id, {
						updatedAt: sessionExerciseUpdatedAt
					}),
					'Exercise disappeared while its set was being removed.'
				);
				await requireRowUpdate(
					database.workoutSessions.update(sessionExercise.sessionId, {
						updatedAt: nextSession.updatedAt
					}),
					'Session disappeared while its set was being removed.'
				);
			} catch (error) {
				return compensateSessionEdit(database, error, compensationAttempt);
			}
		}
	);

	if (sessionId && initiatingExpectation) {
		finalizeSessionInputDraftSetsIfUnchanged(
			initiatingExpectation.inputDraft,
			deletedSetIds,
			userId
		);
	}
}

export async function updateSessionSetInput(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string,
	intent?: { updatedAt: number; baseValue: string },
	admission?: {
		waitFor?: Promise<unknown>;
		signal?: AbortSignal;
		expectedOwnerId?: string | null;
	}
) {
	requireLoggedInUser();

	return updateSessionSetInputs(sessionSetId, field, rawValue, intent, admission);
}

export async function resetSessionInputs(
	sessionId: string,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation((operation) =>
		resetSessionInputsWithOperation(operation, sessionId, destructiveExpectation)
	);
}

async function resetSessionInputsWithOperation(
	operation: AuthenticatedDatabaseOperation,
	sessionId: string,
	destructiveExpectation?: SessionDestructiveEditExpectation
) {
	const { database, userId } = operation;
	await repairPendingSessionEditCompensation(operation, getSessionEditSessionScopeKey(sessionId));
	const initiatingExpectation =
		destructiveExpectation ??
		(await captureSessionResetExpectationWithOperation(operation, sessionId));

	const session = await database.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	const workoutExercises = await listWorkoutExercises(session.workoutId, database);
	const now = timestamp();
	const nextSessionExercises: SessionExercise[] = workoutExercises.map(
		(workoutExercise, index) => ({
			id: getResetSessionExerciseId(
				sessionId,
				session.workoutId,
				workoutExercise.exercise.id,
				index + 1
			),
			sessionId,
			workoutId: session.workoutId,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: session.startedAt ?? now,
			createdAt: now,
			updatedAt: now
		})
	);
	const nextSessionSets = (
		await Promise.all(
			nextSessionExercises.map((sessionExercise, index) =>
				buildSessionSeedSetRows(
					sessionExercise.id,
					workoutExercises[index].exercise,
					now,
					sessionId,
					(order) =>
						getSessionExerciseSeedSetLogicalId(
							sessionExercise.id,
							workoutExercises[index].exercise.id,
							order
						),
					database
				)
			)
		)
	).flat();

	await database.transaction(
		'rw',
		database.sessionSets,
		database.sessionExercises,
		database.workoutSessions,
		async () => {
			const currentSession = await database.workoutSessions.get(sessionId);

			if (!currentSession) {
				throw new Error('Session not found.');
			}

			if (currentSession.status !== 'planned' && currentSession.status !== 'in_progress') {
				throw new Error('Only planned or in-progress sessions can be reset.');
			}

			const sessionExercises = await database.sessionExercises
				.where('sessionId')
				.equals(sessionId)
				.toArray();
			const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
			const sessionSets =
				sessionExerciseIds.length > 0
					? await database.sessionSets
							.where('sessionExerciseId')
							.anyOf(sessionExerciseIds)
							.toArray()
					: [];
			const sessionExerciseById = new Map(
				sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
			);
			const persistedNextSessionExercises = nextSessionExercises.map((nextSessionExercise) => {
				const storedSessionExercise = sessionExerciseById.get(nextSessionExercise.id);

				return storedSessionExercise
					? {
							...nextSessionExercise,
							createdAt: storedSessionExercise.createdAt,
							updatedAt: getNextRowUpdatedAt(storedSessionExercise, now)
						}
					: nextSessionExercise;
			});
			const sessionSetById = new Map(sessionSets.map((sessionSet) => [sessionSet.id, sessionSet]));
			const persistedNextSessionSets = nextSessionSets.map((nextSessionSet) => {
				const storedSessionSet = sessionSetById.get(nextSessionSet.id);

				return storedSessionSet
					? {
							...nextSessionSet,
							createdAt: storedSessionSet.createdAt,
							updatedAt: getNextRowUpdatedAt(storedSessionSet, now)
						}
					: nextSessionSet;
			});
			requireExpectedDestructiveEdit(
				userId,
				currentSession.id,
				sessionExercises,
				sessionSets,
				initiatingExpectation
			);
			const nextSessionExerciseIds = nextSessionExercises.map(
				(sessionExercise) => sessionExercise.id
			);
			const nextSessionSetIds = nextSessionSets.map((sessionSet) => sessionSet.id);

			const nextSessionExerciseIdSet = new Set(nextSessionExerciseIds);
			const nextSessionSetIdSet = new Set(nextSessionSetIds);
			const obsoleteSessionExerciseIds = sessionExerciseIds.filter(
				(id) => !nextSessionExerciseIdSet.has(id)
			);
			const obsoleteSessionSetIds = sessionSets
				.map((sessionSet) => sessionSet.id)
				.filter((id) => !nextSessionSetIdSet.has(id));
			const nextSession: WorkoutSession = {
				...currentSession,
				updatedAt: getNextRowUpdatedAt(currentSession, now)
			};
			const compensationAttempt: SessionEditCompensationAttempt = {
				userId,
				operation: 'Session reset',
				sessionId: currentSession.id,
				scopeKeys: [getSessionEditSessionScopeKey(currentSession.id)],
				mutations: [
					...buildSessionSetEditMutations(sessionSets, persistedNextSessionSets),
					...buildSessionExerciseEditMutations(sessionExercises, persistedNextSessionExercises),
					createWorkoutSessionEditMutation(currentSession, nextSession)
				]
			};

			try {
				if (persistedNextSessionExercises.length > 0) {
					await database.sessionExercises.bulkPut(persistedNextSessionExercises);
				}

				if (persistedNextSessionSets.length > 0) {
					await database.sessionSets.bulkPut(persistedNextSessionSets);
				}

				if (obsoleteSessionExerciseIds.length > 0) {
					await database.sessionExercises.bulkDelete(obsoleteSessionExerciseIds);
				}

				if (obsoleteSessionSetIds.length > 0) {
					await database.sessionSets.bulkDelete(obsoleteSessionSetIds);
				}

				await requireRowUpdate(
					database.workoutSessions.update(sessionId, {
						updatedAt: nextSession.updatedAt
					}),
					'Session disappeared while its inputs were being reset.'
				);
			} catch (error) {
				return compensateSessionEdit(database, error, compensationAttempt);
			}
		}
	);

	if (initiatingExpectation.inputDraft.draft) {
		finalizeSessionInputDraftIfUnchanged(initiatingExpectation.inputDraft.draft, null, userId);
	}
}
