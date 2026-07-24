import { SESSION_INACTIVITY_ABANDON_MS } from '../../session-inactivity';
import type { SessionExercise, WorkoutSession } from '../models';
import {
	canAttemptSessionCleanup,
	confirmSessionCleanupIsFresh,
	db,
	ensureDbOpen,
	getActiveCloudUser,
	markStaleSessionCleanupCompleted,
	requireLoggedInUser,
	syncNow,
	wasStaleSessionCleanupCompleted
} from '../runtime';
import { clearSessionInputDraft } from '../session-drafts';
import {
	createId,
	getSessionActivityAt,
	timestamp,
	toDayKey,
	type SessionActivityTimestamp
} from '../shared';
import { listWorkoutExercises, syncWorkoutExercisesFromSession } from '../workouts';
import { getSessionOverview, listSessionExerciseDetails } from './data';
import { flushSessionInputDraft } from './inputs';
import {
	buildSessionSeedSetRows,
	deleteWorkoutSessionRows,
	ensureEditableSessionSeedRows
} from './seeding';

export async function getStoredSessionActivityAt(session: WorkoutSession) {
	const sessionSets = (await listSessionExerciseDetails(session.id)).flatMap(
		(sessionExercise) => sessionExercise.sets
	);

	return getSessionActivityAt(session, sessionSets);
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

export async function abandonStoredInactiveSession(sessionId: string, nowMs: number) {
	return db.transaction(async () => {
		const session = await db.workoutSessions.get(sessionId);

		if (!session || session.status !== 'in_progress') {
			return false;
		}

		const activityAt = await getStoredSessionActivityAt(session);

		if (!activityAt || !isSessionInactive(session, activityAt, nowMs)) {
			return false;
		}

		await db.workoutSessions.update(session.id, {
			status: 'abandoned',
			completedAt: activityAt.value,
			updatedAt: timestamp()
		});
		clearSessionInputDraft(session.id);
		return true;
	});
}

export async function abandonInactiveWorkoutSession(sessionId: string, nowMs = Date.now()) {
	await ensureDbOpen();
	requireLoggedInUser();

	if (!canAttemptSessionCleanup()) {
		return false;
	}

	await flushSessionInputDraft(sessionId, { clearDraft: false });
	const currentSession = await db.workoutSessions.get(sessionId);
	const currentActivityAt = currentSession
		? await getStoredSessionActivityAt(currentSession)
		: null;

	if (!currentSession || !isSessionInactive(currentSession, currentActivityAt, nowMs)) {
		return false;
	}

	if (!(await confirmSessionCleanupIsFresh())) {
		return false;
	}

	await flushSessionInputDraft(sessionId);
	const abandoned = await abandonStoredInactiveSession(sessionId, nowMs);

	if (!abandoned) {
		return false;
	}

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});

	return true;
}

export async function cleanupStaleSessions(todayDayKey = toDayKey(new Date())) {
	await ensureDbOpen();

	const activeUser = getActiveCloudUser();
	const userId = activeUser.userId;

	if (!activeUser.isLoggedIn || !userId) {
		return;
	}

	if (!canAttemptSessionCleanup()) {
		return;
	}

	const nowMs = Date.now();
	const cleanupKey = `${userId}:${todayDayKey}:${Math.floor(nowMs / 60_000)}`;

	if (wasStaleSessionCleanupCompleted(cleanupKey)) {
		return;
	}

	let [plannedSessions, runningSessions] = await Promise.all([
		db.workoutSessions.where('status').equals('planned').toArray(),
		db.workoutSessions.where('status').equals('in_progress').toArray()
	]);

	for (const runningSession of runningSessions) {
		await flushSessionInputDraft(runningSession.id, { clearDraft: false });
	}

	let stalePlannedSessions = plannedSessions.filter((session) => session.dayKey < todayDayKey);
	const hasStaleRunningSession = (
		await Promise.all(
			runningSessions.map(async (session) => {
				const activityAt = await getStoredSessionActivityAt(session);
				return isSessionInactive(session, activityAt, nowMs);
			})
		)
	).some(Boolean);

	if (stalePlannedSessions.length === 0 && !hasStaleRunningSession) {
		markStaleSessionCleanupCompleted(cleanupKey);
		return;
	}

	if (!(await confirmSessionCleanupIsFresh())) {
		return;
	}

	[plannedSessions, runningSessions] = await Promise.all([
		db.workoutSessions.where('status').equals('planned').toArray(),
		db.workoutSessions.where('status').equals('in_progress').toArray()
	]);

	for (const runningSession of runningSessions) {
		await flushSessionInputDraft(runningSession.id);
	}

	stalePlannedSessions = plannedSessions.filter((session) => session.dayKey < todayDayKey);

	await db.transaction(async () => {
		for (const stalePlannedSession of stalePlannedSessions) {
			const currentSession = await db.workoutSessions.get(stalePlannedSession.id);

			if (currentSession?.status !== 'planned' || currentSession.dayKey >= todayDayKey) {
				continue;
			}

			await deleteWorkoutSessionRows(currentSession.id);
		}
	});

	for (const runningSession of runningSessions) {
		await abandonStoredInactiveSession(runningSession.id, nowMs);
	}

	markStaleSessionCleanupCompleted(cleanupKey);
}
export async function scheduleWorkoutSession(workoutId: string, dayKey: string) {
	requireLoggedInUser();

	const todayDayKey = toDayKey(new Date());

	if (dayKey !== todayDayKey) {
		throw new Error('You can only schedule a workout for today.');
	}

	await cleanupStaleSessions(todayDayKey);

	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) =>
			session.status === 'planned' ||
			session.status === 'in_progress' ||
			session.status === 'completed' ||
			session.status === 'abandoned'
	);

	if (existingSession) {
		throw new Error('A session already exists for today.');
	}

	const workout = await db.workouts.get(workoutId);

	if (!workout || workout.archived) {
		throw new Error('Workout not found.');
	}

	const workoutExercises = await listWorkoutExercises(workoutId);
	const createdAt = timestamp();
	const session: WorkoutSession = {
		id: createId(),
		workoutId,
		workoutNameSnapshot: workout.name,
		dayKey,
		status: 'planned',
		createdAt,
		updatedAt: createdAt
	};
	const sessionExercises: SessionExercise[] = workoutExercises.map((workoutExercise, index) => ({
		id: createId(),
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
				buildSessionSeedSetRows(sessionExercise.id, workoutExercises[index].exercise, createdAt)
			)
		)
	).flat();

	await db.transaction(async () => {
		const conflictingSession = (
			await db.workoutSessions.where('dayKey').equals(dayKey).toArray()
		).find((candidate) => candidate.id !== session.id);

		if (conflictingSession) {
			throw new Error('A session already exists for today.');
		}

		await db.workoutSessions.add(session);

		if (sessionExercises.length > 0) {
			await db.sessionExercises.bulkAdd(sessionExercises);
		}

		if (sessionSets.length > 0) {
			await db.sessionSets.bulkAdd(sessionSets);
		}

		await db.workouts.update(workoutId, { updatedAt: createdAt });
	});
}

export async function startWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	const now = timestamp();
	let didStart = false;

	await db.transaction(async () => {
		const currentSession = await db.workoutSessions.get(sessionId);

		if (!currentSession) {
			throw new Error('Session not found.');
		}

		if (currentSession.status !== 'planned' && currentSession.status !== 'abandoned') {
			return;
		}

		const isResuming = currentSession.status === 'abandoned';

		if (isResuming && currentSession.dayKey !== toDayKey(new Date())) {
			throw new Error("Only today's abandoned session can be resumed.");
		}

		const previousStartedAtMs = currentSession.startedAt
			? new Date(currentSession.startedAt).getTime()
			: NaN;
		const previousCompletedAtMs = currentSession.completedAt
			? new Date(currentSession.completedAt).getTime()
			: NaN;
		const previousActiveDurationMs =
			Number.isFinite(previousStartedAtMs) &&
			Number.isFinite(previousCompletedAtMs) &&
			previousCompletedAtMs >= previousStartedAtMs
				? previousCompletedAtMs - previousStartedAtMs
				: 0;
		const resumedStartedAt = timestamp(new Date(Date.now() - previousActiveDurationMs));
		const resumedStartedAtMs = new Date(resumedStartedAt).getTime();
		const resumedStartDeltaMs =
			isResuming && Number.isFinite(previousStartedAtMs) && Number.isFinite(resumedStartedAtMs)
				? resumedStartedAtMs - previousStartedAtMs
				: 0;
		await db.workoutSessions.update(sessionId, {
			status: 'in_progress',
			startedAt: isResuming ? resumedStartedAt : now,
			completedAt: undefined,
			updatedAt: now
		});
		didStart = true;

		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();

		if (sessionExercises.length > 0) {
			await Promise.all(
				sessionExercises.map((sessionExercise) => {
					const performedAtMs = new Date(sessionExercise.performedAt).getTime();
					const nextPerformedAt =
						isResuming && Number.isFinite(performedAtMs)
							? timestamp(new Date(performedAtMs + resumedStartDeltaMs))
							: now;

					return db.sessionExercises.update(sessionExercise.id, {
						performedAt: nextPerformedAt,
						updatedAt: now
					});
				})
			);
		}
	});

	if (didStart) {
		void syncNow().catch((error) => {
			console.warn('Background Supabase sync failed.', error);
		});
	}
}

export async function completeWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (session.status === 'completed' || session.status === 'abandoned') {
		return;
	}

	await flushSessionInputDraft(sessionId);

	const now = timestamp();
	let didComplete = false;

	await db.transaction(async () => {
		const currentSession = await db.workoutSessions.get(sessionId);

		if (!currentSession) {
			throw new Error('Session not found.');
		}

		if (currentSession.status === 'completed' || currentSession.status === 'abandoned') {
			return;
		}

		if (currentSession.status !== 'in_progress') {
			throw new Error('Start the session before completing it.');
		}

		await syncWorkoutExercisesFromSession(sessionId, now);
		await db.workoutSessions.update(sessionId, {
			status: 'completed',
			startedAt: currentSession.startedAt ?? now,
			completedAt: now,
			updatedAt: now
		});
		didComplete = true;
	});

	if (!didComplete) {
		return;
	}

	clearSessionInputDraft(sessionId);

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});
}

export async function updateWorkoutSessionTiming(
	sessionId: string,
	nextStartedAt: string,
	nextCompletedAt?: string
) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

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

	if (session.status === 'planned') {
		throw new Error('Start the session before editing its time.');
	}

	if (session.status === 'completed' && !completedAtDate) {
		throw new Error('End time is required for a completed session.');
	}

	const now = timestamp();

	await db.transaction(async () => {
		const currentSession = await db.workoutSessions.get(sessionId);

		if (!currentSession) {
			throw new Error('Session not found.');
		}

		if (currentSession.status === 'planned') {
			throw new Error('Start the session before editing its time.');
		}

		if (currentSession.status === 'completed' && !completedAtDate) {
			throw new Error('End time is required for a completed session.');
		}

		const nextDayKey = toDayKey(startedAtDate);
		const conflictingSession = (
			await db.workoutSessions.where('dayKey').equals(nextDayKey).toArray()
		).find((candidate) => candidate.id !== sessionId);

		if (conflictingSession) {
			throw new Error('A session already exists for that day.');
		}

		const currentStartedAtMs = currentSession.startedAt
			? new Date(currentSession.startedAt).getTime()
			: NaN;
		const startedAtDeltaMs = Number.isNaN(currentStartedAtMs)
			? 0
			: startedAtDate.getTime() - currentStartedAtMs;

		await db.workoutSessions.update(sessionId, {
			startedAt: timestamp(startedAtDate),
			completedAt: completedAtDate ? timestamp(completedAtDate) : undefined,
			dayKey: nextDayKey,
			updatedAt: now
		});

		if (startedAtDeltaMs === 0) {
			return;
		}

		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();

		await Promise.all(
			sessionExercises.map((sessionExercise) => {
				const performedAtMs = new Date(sessionExercise.performedAt).getTime();
				const nextPerformedAt = Number.isNaN(performedAtMs)
					? startedAtDate
					: new Date(performedAtMs + startedAtDeltaMs);

				return db.sessionExercises.update(sessionExercise.id, {
					performedAt: timestamp(nextPerformedAt),
					updatedAt: now
				});
			})
		);
	});

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});
}

export async function getEditableSession(sessionId: string) {
	await ensureDbOpen();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	await ensureEditableSessionSeedRows(session, await listSessionExerciseDetails(sessionId));

	return getSessionOverview(sessionId);
}

export async function deleteWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	await db.transaction(async () => {
		const session = await deleteWorkoutSessionRows(sessionId);

		if (!session) {
			return;
		}

		await db.workouts.update(session.workoutId, { updatedAt: timestamp() });
	});
}
