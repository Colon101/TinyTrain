import type { SessionExercise, WorkoutSession } from '../models';
import { timestamp } from '../shared';

export type SessionResumeTiming = {
	startedAt: string;
	startedAtDeltaMs: number;
	updatedAt: string;
};

export function buildSessionResumeTiming(
	session: Pick<WorkoutSession, 'startedAt' | 'completedAt'>,
	resumedAt = timestamp()
): SessionResumeTiming {
	const resumedAtMs = new Date(resumedAt).getTime();
	const previousStartedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
	const previousCompletedAtMs = session.completedAt ? new Date(session.completedAt).getTime() : NaN;
	const previousActiveDurationMs =
		Number.isFinite(previousStartedAtMs) &&
		Number.isFinite(previousCompletedAtMs) &&
		previousCompletedAtMs >= previousStartedAtMs
			? previousCompletedAtMs - previousStartedAtMs
			: 0;
	const resumedStartedAt = timestamp(new Date(resumedAtMs - previousActiveDurationMs));
	const resumedStartedAtMs = new Date(resumedStartedAt).getTime();

	return {
		startedAt: resumedStartedAt,
		startedAtDeltaMs:
			Number.isFinite(previousStartedAtMs) && Number.isFinite(resumedStartedAtMs)
				? resumedStartedAtMs - previousStartedAtMs
				: 0,
		updatedAt: resumedAt
	};
}

export function getResumedSessionExercisePerformedAt(
	sessionExercise: Pick<SessionExercise, 'performedAt'>,
	resumeTiming: SessionResumeTiming
) {
	const performedAtMs = new Date(sessionExercise.performedAt).getTime();

	return Number.isFinite(performedAtMs)
		? timestamp(new Date(performedAtMs + resumeTiming.startedAtDeltaMs))
		: resumeTiming.updatedAt;
}
