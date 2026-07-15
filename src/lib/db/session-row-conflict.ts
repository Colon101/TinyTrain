import type { SessionExercise, WorkoutSession } from './models';

type ConflictWinner = 'first' | 'second';

type ConflictChoice<T> = {
	row: T;
	winner: ConflictWinner;
};

type WorkoutSessionMergeField =
	| 'workoutId'
	| 'workoutNameSnapshot'
	| 'dayKey'
	| 'status'
	| 'startedAt'
	| 'completedAt';

type SessionExerciseMergeField = 'exerciseId' | 'exerciseNameSnapshot' | 'order' | 'performedAt';

const workoutSessionMergeFieldGroups = [
	['workoutId', 'workoutNameSnapshot'],
	['dayKey']
] as const satisfies readonly (readonly WorkoutSessionMergeField[])[];

const workoutSessionLifecycleFields = [
	'status',
	'startedAt',
	'completedAt'
] as const satisfies readonly WorkoutSessionMergeField[];

const sessionExerciseMergeFieldGroups = [
	// An exercise id and its displayed snapshot describe one replacement. Mixing them can show the
	// wrong name and, more importantly, disconnect this parent row from its replacement child sets.
	['exerciseId', 'exerciseNameSnapshot'],
	['order'],
	['performedAt']
] as const satisfies readonly (readonly SessionExerciseMergeField[])[];

function getTimestamp(row: { createdAt: string; updatedAt: string }) {
	const time = new Date(row.updatedAt || row.createdAt).getTime();

	return Number.isFinite(time) ? time : 0;
}

function chooseConflict<T extends { createdAt: string; updatedAt: string }>(
	first: T,
	second: T
): ConflictChoice<T> {
	const firstTimestamp = getTimestamp(first);
	const secondTimestamp = getTimestamp(second);

	if (firstTimestamp !== secondTimestamp) {
		return firstTimestamp > secondTimestamp
			? { row: first, winner: 'first' }
			: { row: second, winner: 'second' };
	}

	// RxDB can run the same conflict on either peer. A content tie-break keeps convergence
	// independent of which branch happened to be called "master" on that peer.
	const firstTieBreakValue = JSON.stringify(first);
	const secondTieBreakValue = JSON.stringify(second);

	return firstTieBreakValue >= secondTieBreakValue
		? { row: first, winner: 'first' }
		: { row: second, winner: 'second' };
}

function fieldsAreEqual<T extends object>(first: T, second: T, fields: readonly (keyof T)[]) {
	return fields.every((field) => Object.is(first[field], second[field]));
}

function copyFields<T extends object>(target: T, source: T, fields: readonly (keyof T)[]) {
	const targetRecord = target as Record<keyof T, unknown>;
	const sourceRecord = source as Record<keyof T, unknown>;

	for (const field of fields) {
		const value = sourceRecord[field];

		if (value === undefined) {
			delete targetRecord[field];
		} else {
			targetRecord[field] = value;
		}
	}
}

function mergeFieldGroups<T extends { createdAt: string; updatedAt: string }>(
	first: T,
	second: T,
	base: T,
	resolved: T,
	choice: ConflictChoice<T>,
	groups: readonly (readonly (keyof T)[])[]
) {
	for (const fields of groups) {
		const firstChanged = !fieldsAreEqual(first, base, fields);
		const secondChanged = !fieldsAreEqual(second, base, fields);
		let source: T;

		if (firstChanged && !secondChanged) {
			source = first;
		} else if (secondChanged && !firstChanged) {
			source = second;
		} else if (fieldsAreEqual(first, second, fields)) {
			source = first;
		} else {
			source = choice.row;
		}

		copyFields(resolved, source, fields);
	}
}

function chooseWorkoutSessionLifecycleSource<T extends WorkoutSession>(
	first: T,
	second: T,
	base: T,
	choice: ConflictChoice<T>
) {
	if (fieldsAreEqual(first, second, workoutSessionLifecycleFields)) {
		return first;
	}

	// Completion is terminal. A later keystroke can advance updatedAt on a stale in-progress copy,
	// but it must not reopen the session or erase completedAt.
	if (first.status === 'completed' || second.status === 'completed') {
		return first.status === 'completed' ? first : second;
	}

	// Abandoned sessions are deliberately resumable. This is a real lifecycle transition, unlike
	// stale in-progress activity from a client whose common base was already abandoned.
	if (base.status === 'abandoned') {
		if (first.status === 'in_progress' && second.status === 'abandoned') {
			return first;
		}
		if (second.status === 'in_progress' && first.status === 'abandoned') {
			return second;
		}
	}

	const firstStatusChanged = first.status !== base.status;
	const secondStatusChanged = second.status !== base.status;

	if (firstStatusChanged !== secondStatusChanged) {
		return firstStatusChanged ? first : second;
	}

	const firstChanged = !fieldsAreEqual(first, base, workoutSessionLifecycleFields);
	const secondChanged = !fieldsAreEqual(second, base, workoutSessionLifecycleFields);

	if (firstChanged !== secondChanged) {
		return firstChanged ? first : second;
	}

	return choice.row;
}

/**
 * Merges session lifecycle and metadata from two branches that share the supplied master revision.
 * Status and its timestamps move together so stale activity cannot reopen or corrupt a terminal
 * session even when that activity carries the later row timestamp.
 */
export function mergeWorkoutSessionConflict<T extends WorkoutSession>(
	first: T,
	second: T,
	base: T
): T {
	const choice = chooseConflict(first, second);
	const resolved = { ...choice.row };

	mergeFieldGroups(
		first,
		second,
		base,
		resolved,
		choice,
		workoutSessionMergeFieldGroups as readonly (readonly (keyof T)[])[]
	);
	copyFields(
		resolved,
		chooseWorkoutSessionLifecycleSource(first, second, base, choice),
		workoutSessionLifecycleFields
	);

	return resolved;
}

/**
 * Preserves a replacement's exercise id/name as one atomic edit while independently merging a
 * concurrent reorder or performed-at correction from the same common revision.
 */
export function mergeSessionExerciseConflict<T extends SessionExercise>(
	first: T,
	second: T,
	base: T
): T {
	const choice = chooseConflict(first, second);
	const resolved = { ...choice.row };

	mergeFieldGroups(
		first,
		second,
		base,
		resolved,
		choice,
		sessionExerciseMergeFieldGroups as readonly (readonly (keyof T)[])[]
	);

	return resolved;
}
