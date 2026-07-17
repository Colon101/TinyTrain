import type { SessionSet } from './models';

type SessionSetConflictWinner = 'first' | 'second';

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

	return firstTimestamp >= secondTimestamp
		? { row: first, winner: 'first' }
		: { row: second, winner: 'second' };
}
