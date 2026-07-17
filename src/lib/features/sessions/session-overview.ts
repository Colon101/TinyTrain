import type { SessionExerciseOverview, SessionSetOverview, SessionStatus } from '$lib/db';

export function formatSetCellValue(value?: number) {
	return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : '-';
}

export function getDeltaToneClass(state: 'improved' | 'regressed' | 'matched' | 'empty') {
	if (state === 'improved') {
		return 'text-positive';
	}

	if (state === 'regressed') {
		return 'text-red-300';
	}

	return 'text-zinc-500';
}

export function hasLoggedValues(sessionExercise: SessionExerciseOverview) {
	return sessionExercise.sets.some(
		(sessionSet) =>
			sessionSet.weightInput?.trim() || sessionSet.repsInput?.trim() || sessionSet.rirInput?.trim()
	);
}

export function hasPerformedSetValue(sessionSet: SessionSetOverview) {
	return (
		Boolean(sessionSet.weightInput?.trim()) ||
		Boolean(sessionSet.repsInput?.trim()) ||
		Boolean(sessionSet.rirInput?.trim()) ||
		(typeof sessionSet.weight === 'number' && Number.isFinite(sessionSet.weight)) ||
		(typeof sessionSet.reps === 'number' && Number.isFinite(sessionSet.reps)) ||
		(typeof sessionSet.rir === 'number' && Number.isFinite(sessionSet.rir))
	);
}

export function getPerformedSets(sessionExercise: SessionExerciseOverview): SessionSetOverview[] {
	const sets = sessionExercise.sets as SessionSetOverview[];

	if (!sessionExercise.exercise?.unilateral) {
		return sets.filter(hasPerformedSetValue);
	}

	const performedOrders = new Set<number>(
		sets.filter(hasPerformedSetValue).map((sessionSet) => sessionSet.order)
	);

	return sets.filter((sessionSet) => performedOrders.has(sessionSet.order));
}

export function getUniqueSetCount(sessionExercise: SessionExerciseOverview) {
	return new Set(sessionExercise.sets.map((sessionSet) => sessionSet.order)).size;
}

export function getExerciseSetSummary(
	sessionExercise: SessionExerciseOverview,
	status: SessionStatus,
	performedSetCount: number
) {
	if (status === 'in_progress') {
		return `${performedSetCount} performed set${performedSetCount === 1 ? '' : 's'}`;
	}

	const setCount = getUniqueSetCount(sessionExercise);
	const laterality = sessionExercise.exercise?.unilateral ? 'Unilateral' : 'Bilateral';

	return `${laterality} · ${setCount} set${setCount === 1 ? '' : 's'}`;
}
