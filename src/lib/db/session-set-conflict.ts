import type { SessionSet } from './models';

type SessionSetConflictWinner = 'first' | 'second';

type SessionSetMergeField =
	| 'order'
	| 'side'
	| 'weightInput'
	| 'weight'
	| 'repsInput'
	| 'reps'
	| 'rirInput'
	| 'rir';

const sessionSetMergeFieldGroups = [
	['order'],
	['side'],
	['weightInput', 'weight'],
	['repsInput', 'reps'],
	['rirInput', 'rir']
] as const satisfies readonly (readonly SessionSetMergeField[])[];

export type SessionSetConflictChoice<T extends SessionSet> = {
	row: T;
	winner: SessionSetConflictWinner;
};

function getTimestamp(row: Pick<SessionSet, 'createdAt' | 'updatedAt'>) {
	const time = new Date(row.updatedAt || row.createdAt).getTime();

	return Number.isFinite(time) ? time : 0;
}

function wasEditedAfterCreate(row: Pick<SessionSet, 'createdAt' | 'updatedAt'>) {
	const createdAt = new Date(row.createdAt).getTime();

	return getTimestamp(row) > (Number.isFinite(createdAt) ? createdAt : 0);
}

function getCompletenessScore(sessionSet: SessionSet) {
	const inputScore = [
		getInputValue(sessionSet.weightInput, sessionSet.weight),
		getInputValue(sessionSet.repsInput, sessionSet.reps),
		getInputValue(sessionSet.rirInput, sessionSet.rir)
	].reduce<number>(
		(score, value) => score + Number(typeof value === 'string' && value.trim().length > 0),
		0
	);
	const numericScore = [sessionSet.weight, sessionSet.reps, sessionSet.rir].reduce<number>(
		(score, value) => score + Number(typeof value === 'number' && Number.isFinite(value)),
		0
	);

	return inputScore * 2 + numericScore;
}

function getInputValue(rawValue: string | undefined, numericValue: number | undefined) {
	if (typeof rawValue === 'string') {
		return rawValue;
	}

	return typeof numericValue === 'number' && Number.isFinite(numericValue) ? `${numericValue}` : '';
}

function getDeterministicTieBreakValue(sessionSet: SessionSet) {
	return JSON.stringify([
		sessionSet.id,
		sessionSet.sessionExerciseId,
		sessionSet.exerciseId,
		sessionSet.order,
		sessionSet.side,
		sessionSet.weightInput ?? null,
		sessionSet.weight ?? null,
		sessionSet.repsInput ?? null,
		sessionSet.reps ?? null,
		sessionSet.rirInput ?? null,
		sessionSet.rir ?? null,
		sessionSet.createdAt,
		sessionSet.updatedAt
	]);
}

function fieldsAreEqual(
	first: SessionSet,
	second: SessionSet,
	fields: readonly SessionSetMergeField[]
) {
	return fields.every((field) => Object.is(first[field], second[field]));
}

function copyFields<T extends SessionSet>(
	target: T,
	source: T,
	fields: readonly SessionSetMergeField[]
) {
	const targetRecord = target as unknown as Record<SessionSetMergeField, unknown>;
	const sourceRecord = source as unknown as Record<SessionSetMergeField, unknown>;

	for (const field of fields) {
		const value = sourceRecord[field];

		if (value === undefined) {
			delete targetRecord[field];
		} else {
			targetRecord[field] = value;
		}
	}
}

export function chooseSessionSetConflict<T extends SessionSet>(
	first: T,
	second: T
): SessionSetConflictChoice<T> {
	const firstTimestamp = getTimestamp(first);
	const secondTimestamp = getTimestamp(second);

	if (firstTimestamp !== secondTimestamp) {
		const firstIsNewer = firstTimestamp > secondTimestamp;
		const newerRow = firstIsNewer ? first : second;

		if (wasEditedAfterCreate(newerRow)) {
			return firstIsNewer ? { row: first, winner: 'first' } : { row: second, winner: 'second' };
		}
	}

	const firstScore = getCompletenessScore(first);
	const secondScore = getCompletenessScore(second);

	if (firstScore !== secondScore) {
		return firstScore > secondScore
			? { row: first, winner: 'first' }
			: { row: second, winner: 'second' };
	}

	if (firstTimestamp !== secondTimestamp) {
		return firstTimestamp > secondTimestamp
			? { row: first, winner: 'first' }
			: { row: second, winner: 'second' };
	}

	const firstTieBreakValue = getDeterministicTieBreakValue(first);
	const secondTieBreakValue = getDeterministicTieBreakValue(second);

	return firstTieBreakValue >= secondTieBreakValue
		? { row: first, winner: 'first' }
		: { row: second, winner: 'second' };
}

/**
 * Three-way merges concurrent edits against the last master revision observed by the client.
 * Input text and its parsed number move together so the resolved row cannot combine values from
 * two different edits of the same logical field.
 */
export function mergeSessionSetConflict<T extends SessionSet>(
	first: T,
	second: T,
	base: T | undefined
): T {
	if (!base) {
		return chooseSessionSetConflict(first, second).row;
	}

	const choice = chooseSessionSetConflict(first, second);
	const resolved = { ...choice.row };

	for (const fields of sessionSetMergeFieldGroups) {
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
			// Concurrent edits to the same logical field use the deterministic whole-row winner.
			source = choice.row;
		}

		copyFields(resolved, source, fields);
	}

	return resolved;
}
