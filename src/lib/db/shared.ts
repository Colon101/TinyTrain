import { BASELINE_EXERCISE_BY_ID, BASELINE_EXERCISE_BY_NORMALIZED_NAME } from '../exercises';
import type {
	Exercise,
	ExerciseHistoryEntry,
	ExerciseSource,
	SessionExercise,
	SessionExerciseDetail,
	SessionFieldDelta,
	SessionInputField,
	SessionSet,
	SessionSetReference,
	SessionSetSide,
	SessionSummary,
	WorkoutSession
} from './models';

export function toDayKey(input: Date | string) {
	const date = toValidDate(input);

	return [
		String(date.getFullYear()).padStart(4, '0'),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0')
	].join('-');
}

export function toValidDate(input: Date | string) {
	const date = input instanceof Date ? new Date(input) : new Date(input);

	if (Number.isNaN(date.getTime())) {
		return new Date();
	}

	return date;
}

export function timestamp(date = new Date()) {
	return date.toISOString();
}

export function isDefined<T>(value: T): value is NonNullable<T> {
	return value !== undefined && value !== null;
}

export function createId() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeName(name: string) {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function displayName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

export function inferExerciseSource(nameOrNormalizedName: string, source?: ExerciseSource) {
	if (source) {
		return source;
	}

	return BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(normalizeName(nameOrNormalizedName))
		? 'baseline'
		: 'custom';
}

export function withExerciseDefaults(exercise: Exercise): Exercise {
	return {
		...exercise,
		unilateral: Boolean(exercise.unilateral),
		source: inferExerciseSource(exercise.normalizedName || exercise.name, exercise.source)
	};
}

export function compareExercises(first: Exercise, second: Exercise) {
	if (first.archived !== second.archived) {
		return Number(first.archived) - Number(second.archived);
	}

	if (BASELINE_EXERCISE_BY_ID.has(first.id) !== BASELINE_EXERCISE_BY_ID.has(second.id)) {
		return BASELINE_EXERCISE_BY_ID.has(first.id) ? -1 : 1;
	}

	if (first.source !== second.source) {
		return first.source === 'baseline' ? -1 : 1;
	}

	if (first.updatedAt !== second.updatedAt) {
		return second.updatedAt.localeCompare(first.updatedAt);
	}

	if (first.createdAt !== second.createdAt) {
		return first.createdAt.localeCompare(second.createdAt);
	}

	return first.id.localeCompare(second.id);
}

export function pickPreferredExercise(exercises: Exercise[]) {
	return exercises.map(withExerciseDefaults).sort(compareExercises)[0] ?? null;
}

export function dedupeExercises(exercises: Exercise[]) {
	const exerciseByNormalizedName = new Map<string, Exercise>();

	for (const exercise of exercises.map(withExerciseDefaults)) {
		const existingExercise = exerciseByNormalizedName.get(exercise.normalizedName);

		if (!existingExercise || compareExercises(exercise, existingExercise) < 0) {
			exerciseByNormalizedName.set(exercise.normalizedName, exercise);
		}
	}

	return [...exerciseByNormalizedName.values()];
}

export function toOptionalNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function toStoredInputValue(rawValue?: string, numericValue?: number) {
	if (typeof rawValue === 'string') {
		return rawValue;
	}

	return typeof numericValue === 'number' && Number.isFinite(numericValue) ? `${numericValue}` : '';
}

export function toParsedInputValue(rawValue: string, field?: SessionInputField) {
	if (!rawValue.trim()) {
		return undefined;
	}

	const cleanValue = toCleanSessionInputValue(rawValue, field);

	if (!cleanValue) {
		return undefined;
	}

	const nextValue = Number(cleanValue);

	return Number.isFinite(nextValue) ? nextValue : undefined;
}

export function toCleanSessionInputValue(rawValue: string, field?: SessionInputField) {
	return field === 'reps' || field === 'rir' ? rawValue.trim().replace(/\D/g, '') : rawValue.trim();
}

export function normalizeSessionSetSide(side: unknown): SessionSetSide {
	return side === 'left' || side === 'right' || side === 'bilateral' ? side : 'bilateral';
}

export function hasInputValue(value?: string) {
	return typeof value === 'string' && value.trim().length > 0;
}

export function hasAnySetValue(
	sessionSet: Pick<SessionSet, 'weight' | 'reps' | 'rir' | 'weightInput' | 'repsInput' | 'rirInput'>
) {
	return (
		hasInputValue(sessionSet.weightInput) ||
		hasInputValue(sessionSet.repsInput) ||
		hasInputValue(sessionSet.rirInput) ||
		(typeof sessionSet.weight === 'number' && Number.isFinite(sessionSet.weight)) ||
		(typeof sessionSet.reps === 'number' && Number.isFinite(sessionSet.reps)) ||
		(typeof sessionSet.rir === 'number' && Number.isFinite(sessionSet.rir))
	);
}

export function hasPerformedSetValues(
	sessionSets: Array<
		Pick<SessionSet, 'weight' | 'reps' | 'rir' | 'weightInput' | 'repsInput' | 'rirInput'>
	>
) {
	return sessionSets.some(hasAnySetValue);
}

export function getSessionSortTime(session: Pick<WorkoutSession, 'startedAt' | 'createdAt'>) {
	return toValidDate(session.startedAt ?? session.createdAt).getTime();
}

export function getExerciseHistorySortTime(
	entry: Pick<ExerciseHistoryEntry, 'performedAt' | 'startedAt' | 'completedAt' | 'dayKey'>
) {
	return toValidDate(
		entry.performedAt ?? entry.startedAt ?? entry.completedAt ?? `${entry.dayKey}T12:00:00`
	).getTime();
}

export function compareSessionRows(
	first: Pick<WorkoutSession, 'id' | 'startedAt' | 'createdAt'>,
	second: Pick<WorkoutSession, 'id' | 'startedAt' | 'createdAt'>
) {
	return (
		getSessionSortTime(first) - getSessionSortTime(second) || first.id.localeCompare(second.id)
	);
}

export function getWorkoutSessionRecencyTimestamp(session: WorkoutSession) {
	return session.completedAt ?? session.startedAt ?? session.createdAt;
}

export function compareOptionalRecency(first?: string, second?: string) {
	if (first && second && first !== second) {
		return second.localeCompare(first);
	}

	if (first && !second) {
		return -1;
	}

	if (!first && second) {
		return 1;
	}

	return 0;
}

export function getSessionSetSideOrder(side: SessionSetSide) {
	switch (side) {
		case 'right':
			return 1;
		case 'left':
			return 2;
		default:
			return 0;
	}
}

export function compareSessionSetRows(
	first: Pick<SessionSet, 'id' | 'order' | 'side'>,
	second: Pick<SessionSet, 'id' | 'order' | 'side'>
) {
	if (first.order !== second.order) {
		return first.order - second.order;
	}

	return (
		getSessionSetSideOrder(normalizeSessionSetSide(first.side)) -
			getSessionSetSideOrder(normalizeSessionSetSide(second.side)) ||
		first.id.localeCompare(second.id)
	);
}

export function getSessionSetLabel(sessionSet: Pick<SessionSet, 'order' | 'side'>) {
	const side = normalizeSessionSetSide(sessionSet.side);

	if (side === 'bilateral') {
		return `Set ${String(sessionSet.order).padStart(2, '0')}`;
	}

	return `${side === 'right' ? 'R' : 'L'}${sessionSet.order}`;
}

export function getSessionSetKey(sessionSet: Pick<SessionSet, 'order' | 'side'>) {
	return `${sessionSet.order}:${normalizeSessionSetSide(sessionSet.side)}`;
}

export function withSessionSetDefaults(sessionSet: SessionSet): SessionSet {
	return {
		...sessionSet,
		side: normalizeSessionSetSide(sessionSet.side),
		weightInput: toStoredInputValue(sessionSet.weightInput, toOptionalNumber(sessionSet.weight)),
		repsInput: toStoredInputValue(sessionSet.repsInput, toOptionalNumber(sessionSet.reps)),
		rirInput: toStoredInputValue(sessionSet.rirInput, toOptionalNumber(sessionSet.rir)),
		weight: toOptionalNumber(sessionSet.weight),
		reps: toOptionalNumber(sessionSet.reps),
		rir: toOptionalNumber(sessionSet.rir)
	};
}

export function formatSignedDelta(diff: number) {
	return `${diff > 0 ? '+' : ''}${Number(diff.toFixed(2))}`;
}

export function createFieldDelta(current?: number, previous?: number): SessionFieldDelta {
	if (
		typeof current !== 'number' ||
		!Number.isFinite(current) ||
		typeof previous !== 'number' ||
		!Number.isFinite(previous)
	) {
		return {
			state: 'empty',
			label: ''
		};
	}

	const diff = Number((current - previous).toFixed(2));

	if (diff > 0) {
		return {
			state: 'improved',
			label: formatSignedDelta(diff)
		};
	}

	if (diff < 0) {
		return {
			state: 'regressed',
			label: formatSignedDelta(diff)
		};
	}

	return {
		state: 'matched',
		label: ''
	};
}

export function toSessionSetReference(
	entry: ExerciseHistoryEntry,
	sessionSet: SessionSet
): SessionSetReference {
	return {
		sessionId: entry.sessionId,
		startedAt: entry.startedAt,
		completedAt: entry.completedAt,
		order: sessionSet.order,
		side: sessionSet.side,
		weight: sessionSet.weight,
		reps: sessionSet.reps,
		rir: sessionSet.rir
	};
}

export function buildPreviousReferenceBySetKey(
	currentExercise: SessionExerciseDetail,
	previousPerformance: ExerciseHistoryEntry | null
) {
	const referenceBySetKey = new Map<string, SessionSetReference>();

	if (!previousPerformance) {
		return referenceBySetKey;
	}

	for (const currentSet of currentExercise.sets) {
		const setKey = getSessionSetKey(currentSet);

		if (referenceBySetKey.has(setKey)) {
			continue;
		}

		const previousSet = previousPerformance.sets.find(
			(candidate) => getSessionSetKey(candidate) === setKey && hasAnySetValue(candidate)
		);

		if (previousSet) {
			referenceBySetKey.set(setKey, toSessionSetReference(previousPerformance, previousSet));
		}
	}

	return referenceBySetKey;
}

export function getSessionSetOrderCount(sessionSets: Array<Pick<SessionSet, 'order'>>) {
	return sessionSets.reduce((highestOrder, sessionSet) => {
		return Math.max(highestOrder, sessionSet.order);
	}, 0);
}

export function findLatestHistoryEntryWithPerformedSets(history: ExerciseHistoryEntry[]) {
	return (
		history.find(
			(entry) => getSessionSetOrderCount(entry.sets) > 0 && hasPerformedSetValues(entry.sets)
		) ?? null
	);
}

export function summarizeExerciseProgress(
	currentExercise: SessionExerciseDetail,
	previousReferenceBySetKey: Map<string, SessionSetReference>
) {
	if (previousReferenceBySetKey.size === 0) {
		return {
			progressStatus: 'new' as const,
			progressSummary: 'First logged performance for this exercise.'
		};
	}

	let improvedFieldCount = 0;
	let regressedFieldCount = 0;

	for (const currentSet of currentExercise.sets) {
		const previousReference = previousReferenceBySetKey.get(getSessionSetKey(currentSet));

		if (!previousReference) {
			continue;
		}

		for (const fieldDelta of [
			createFieldDelta(currentSet.weight, previousReference.weight),
			createFieldDelta(currentSet.reps, previousReference.reps),
			createFieldDelta(currentSet.rir, previousReference.rir)
		]) {
			if (fieldDelta.state === 'improved') {
				improvedFieldCount += 1;
				continue;
			}

			if (fieldDelta.state === 'regressed') {
				regressedFieldCount += 1;
			}
		}
	}

	const summaryParts: string[] = [];

	if (improvedFieldCount > 0) {
		summaryParts.push(`${improvedFieldCount} higher field${improvedFieldCount === 1 ? '' : 's'}`);
	}

	if (regressedFieldCount > 0) {
		summaryParts.push(`${regressedFieldCount} lower field${regressedFieldCount === 1 ? '' : 's'}`);
	}

	if (summaryParts.length === 0) {
		return {
			progressStatus: 'matched' as const,
			progressSummary: 'Matched the last workout.'
		};
	}

	if (improvedFieldCount > 0 && regressedFieldCount === 0) {
		return {
			progressStatus: 'improved' as const,
			progressSummary: summaryParts.join(', ')
		};
	}

	if (regressedFieldCount > 0 && improvedFieldCount === 0) {
		return {
			progressStatus: 'regressed' as const,
			progressSummary: summaryParts.join(', ')
		};
	}

	return {
		progressStatus: 'mixed' as const,
		progressSummary: summaryParts.join(', ')
	};
}

export type SessionActivityTimestamp = { value: string; time: number };

export function toSessionActivityTimestamp(value?: string): SessionActivityTimestamp | null {
	const time = value ? new Date(value).getTime() : NaN;
	return value && Number.isFinite(time) ? { value, time } : null;
}

export function getLastSessionSetActivityAt(
	sessionSets: SessionSet[],
	notAfterMs = Number.POSITIVE_INFINITY,
	notBeforeMs = Number.NEGATIVE_INFINITY
) {
	let latestActivity: SessionActivityTimestamp | null = null;

	for (const sessionSet of sessionSets) {
		const createdAtMs = new Date(sessionSet.createdAt).getTime();
		const updatedAtMs = new Date(sessionSet.updatedAt).getTime();

		if (
			!Number.isFinite(createdAtMs) ||
			!Number.isFinite(updatedAtMs) ||
			updatedAtMs <= createdAtMs ||
			updatedAtMs > notAfterMs ||
			updatedAtMs < notBeforeMs ||
			(latestActivity && updatedAtMs <= latestActivity.time)
		) {
			continue;
		}

		latestActivity = {
			value: sessionSet.updatedAt,
			time: updatedAtMs
		};
	}

	return latestActivity;
}

export function getSessionActivityAt(session: WorkoutSession, sessionSets: SessionSet[]) {
	const completedAtMs = session.completedAt ? new Date(session.completedAt).getTime() : NaN;
	const startedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
	const notAfterMs = Number.isFinite(completedAtMs) ? completedAtMs : Number.POSITIVE_INFINITY;
	const notBeforeMs = Number.isFinite(startedAtMs) ? startedAtMs : Number.NEGATIVE_INFINITY;
	const candidates = [
		toSessionActivityTimestamp(session.startedAt),
		getLastSessionSetActivityAt(sessionSets, notAfterMs, notBeforeMs),
		session.status === 'in_progress' ? toSessionActivityTimestamp(session.updatedAt) : null
	].filter((candidate): candidate is SessionActivityTimestamp => candidate !== null);

	return candidates.sort((first, second) => second.time - first.time)[0] ?? null;
}

export function summarizeSession(
	session: WorkoutSession,
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[]
): SessionSummary {
	const totalReps = sessionSets.reduce((total, sessionSet) => {
		return typeof sessionSet.reps === 'number' && Number.isFinite(sessionSet.reps)
			? total + sessionSet.reps
			: total;
	}, 0);
	const totalVolume = sessionSets.reduce((total, sessionSet) => {
		if (
			typeof sessionSet.weight !== 'number' ||
			!Number.isFinite(sessionSet.weight) ||
			typeof sessionSet.reps !== 'number' ||
			!Number.isFinite(sessionSet.reps)
		) {
			return total;
		}

		return total + sessionSet.weight * sessionSet.reps;
	}, 0);
	const completedAtMs = session.completedAt ? new Date(session.completedAt).getTime() : NaN;
	const startedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
	const setActivityCutoffMs = Number.isFinite(completedAtMs)
		? completedAtMs
		: Number.POSITIVE_INFINITY;
	const setActivityStartMs = Number.isFinite(startedAtMs) ? startedAtMs : Number.NEGATIVE_INFINITY;

	return {
		...session,
		dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt),
		lastActivityAt: getSessionActivityAt(session, sessionSets)?.value,
		lastSetActivityAt: getLastSessionSetActivityAt(
			sessionSets,
			setActivityCutoffMs,
			setActivityStartMs
		)?.value,
		totalExercises: sessionExercises.length,
		totalSets: sessionSets.length,
		totalReps,
		totalVolume
	};
}
