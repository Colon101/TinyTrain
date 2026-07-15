import type { SessionInputField, SessionSet } from '../models';
import {
	requireLoggedInUser,
	runAuthenticatedDatabaseOperation,
	type AuthenticatedOperationDatabase
} from '../runtime';
import {
	finalizeSessionInputDraftIfUnchanged,
	isSessionInputDraftSet,
	readSessionInputDraft,
	SESSION_INPUT_INTENT_MAX_FUTURE_MS,
	type SessionInputDraftSet,
	type SessionInputFieldIntentAtKey,
	type SessionInputFieldVersionKey
} from '../session-drafts';
import {
	timestamp,
	sessionSetMatchesSessionExercise,
	toCleanSessionInputValue,
	toParsedInputValue,
	withSessionSetDefaults
} from '../shared';
import { buildSessionResumeTiming, getResumedSessionExercisePerformedAt } from './resume';

type SessionInputDatabase = Pick<
	AuthenticatedOperationDatabase,
	'sessionSets' | 'sessionExercises' | 'workoutSessions' | 'transaction'
>;

async function updateSessionSetInputValuesWithDatabase(
	database: SessionInputDatabase,
	sessionSetId: string,
	rawValues: Partial<Record<SessionInputField, string>>,
	requestedActivityMs?: number | Partial<Record<SessionInputField, number>>,
	baseValues: Partial<Record<SessionInputField, string>> = {},
	options: { resumeAbandoned?: boolean } = {}
) {
	let nextSet: SessionSet | null = null;
	const skippedFields: SessionInputField[] = [];

	await database.transaction(
		'rw',
		database.sessionSets,
		database.sessionExercises,
		database.workoutSessions,
		async () => {
			const sessionSet = await database.sessionSets.get(sessionSetId);

			if (!sessionSet) {
				throw new Error('Set not found.');
			}

			const sessionExercise = await database.sessionExercises.get(sessionSet.sessionExerciseId);

			if (!sessionExercise || !sessionSetMatchesSessionExercise(sessionSet, sessionExercise)) {
				// A losing replacement branch can remain physically stored for convergence, but it is no
				// longer an editable member of the resolved session graph.
				throw new Error('Set not found.');
			}

			const session = await database.workoutSessions.get(sessionExercise.sessionId);

			const normalizedSet = withSessionSetDefaults(sessionSet);
			const patch: Partial<SessionSet> = {};
			const nowMs = Date.now();
			const currentUpdatedAtMs = new Date(sessionSet.updatedAt).getTime();
			let latestAppliedActivityMs = Number.NEGATIVE_INFINITY;
			let hasAcceptedField = false;

			for (const field of ['weight', 'reps', 'rir'] as const) {
				if (!Object.hasOwn(rawValues, field)) {
					continue;
				}

				const inputKey = `${field}Input` as const;
				const cleanInputValue = toCleanSessionInputValue(rawValues[field] ?? '', field);
				const parsedValue = toParsedInputValue(cleanInputValue, field);
				const requestedFieldActivityMs =
					typeof requestedActivityMs === 'number'
						? requestedActivityMs
						: requestedActivityMs?.[field];
				const hasValidRequestedActivity =
					typeof requestedFieldActivityMs === 'number' && Number.isFinite(requestedFieldActivityMs);
				const requestedMs = hasValidRequestedActivity ? requestedFieldActivityMs : nowMs;
				// Retain the small logical-clock lead used to order same-millisecond field edits,
				// while still bounding corrupt or far-future draft timestamps.
				const boundedActivityMs = Math.min(requestedMs, nowMs + SESSION_INPUT_INTENT_MAX_FUTURE_MS);
				const storedRowIsNewer =
					requestedFieldActivityMs !== undefined &&
					(!hasValidRequestedActivity ||
						(Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs > boundedActivityMs));

				if (normalizedSet[inputKey] === cleanInputValue && normalizedSet[field] === parsedValue) {
					// A previous attempt may have committed the set row before a later collection write
					// failed. Treat the matching value as accepted so retry can finish parent metadata.
					hasAcceptedField = true;
					latestAppliedActivityMs = Math.max(
						latestAppliedActivityMs,
						requestedFieldActivityMs === undefined && Number.isFinite(currentUpdatedAtMs)
							? currentUpdatedAtMs
							: boundedActivityMs
					);
					continue;
				}

				if (storedRowIsNewer) {
					const baseValue = baseValues[field];

					if (baseValue === undefined) {
						skippedFields.push(field);
						continue;
					}

					const cleanBaseValue = toCleanSessionInputValue(baseValue, field);
					const parsedBaseValue = toParsedInputValue(cleanBaseValue, field);

					if (
						normalizedSet[inputKey] !== cleanBaseValue ||
						normalizedSet[field] !== parsedBaseValue
					) {
						skippedFields.push(field);
						continue;
					}
				}

				Object.assign(patch, {
					[inputKey]: cleanInputValue,
					[field]: parsedValue
				});
				hasAcceptedField = true;
				latestAppliedActivityMs = Math.max(latestAppliedActivityMs, boundedActivityMs);
			}

			if (!hasAcceptedField) {
				nextSet = normalizedSet;
				return;
			}

			const createdAtMs = new Date(sessionSet.createdAt).getTime();
			const activityMs = Number.isFinite(createdAtMs)
				? Math.max(latestAppliedActivityMs, createdAtMs)
				: latestAppliedActivityMs;
			const storedActivityMs =
				Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs > activityMs
					? currentUpdatedAtMs
					: activityMs;
			const updatedAt = timestamp(new Date(storedActivityMs));

			if (Object.keys(patch).length > 0) {
				patch.updatedAt = updatedAt;
				await database.sessionSets.update(sessionSetId, patch);
				nextSet = withSessionSetDefaults({ ...sessionSet, ...patch });
			} else {
				nextSet = normalizedSet;
			}

			if (session?.status === 'in_progress') {
				const sessionUpdatedAtMs = new Date(session.updatedAt).getTime();
				await database.workoutSessions.update(session.id, {
					updatedAt:
						Number.isFinite(sessionUpdatedAtMs) && sessionUpdatedAtMs > storedActivityMs
							? session.updatedAt
							: updatedAt
				});
			} else if (
				session?.status === 'abandoned' &&
				(requestedActivityMs === undefined || options.resumeAbandoned === true)
			) {
				// A live edit that was already queued when the timeout fired wins the race. Use the
				// accepted input activity as the stable resume instant so retries calculate the same shift.
				const resumeTiming = buildSessionResumeTiming(session, updatedAt);

				const sessionExercises = await database.sessionExercises
					.where('sessionId')
					.equals(session.id)
					.toArray();

				// Finish exercise timing before flipping the session status. Each shifted row carries the
				// stable resume timestamp as an idempotency marker, so a partial failure can retry without
				// shifting a successfully updated exercise twice.
				for (const currentSessionExercise of sessionExercises) {
					if (currentSessionExercise.updatedAt === resumeTiming.updatedAt) {
						continue;
					}

					await database.sessionExercises.update(currentSessionExercise.id, {
						performedAt: getResumedSessionExercisePerformedAt(currentSessionExercise, resumeTiming),
						updatedAt: resumeTiming.updatedAt
					});
				}

				await database.workoutSessions.update(session.id, {
					status: 'in_progress',
					startedAt: resumeTiming.startedAt,
					completedAt: undefined,
					updatedAt: resumeTiming.updatedAt
				});
			}
		}
	);

	if (!nextSet) {
		throw new Error('Set not found.');
	}

	return { sessionSet: nextSet, skippedFields };
}

export async function updateSessionSetInputValues(
	sessionSetId: string,
	rawValues: Partial<Record<SessionInputField, string>>,
	requestedActivityMs?: number | Partial<Record<SessionInputField, number>>,
	baseValues: Partial<Record<SessionInputField, string>> = {},
	options: { resumeAbandoned?: boolean } = {}
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(({ database }) =>
		updateSessionSetInputValuesWithDatabase(
			database,
			sessionSetId,
			rawValues,
			requestedActivityMs,
			baseValues,
			options
		)
	);
}

export async function updateSessionSetInputs(
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
	const result = await runAuthenticatedDatabaseOperation(async ({ userId, database }) => {
		if (
			admission &&
			Object.hasOwn(admission, 'expectedOwnerId') &&
			admission.expectedOwnerId !== userId
		) {
			throw new DOMException('The queued input save owner changed.', 'AbortError');
		}

		if (admission?.waitFor) {
			await admission.waitFor;
		}

		if (admission?.signal?.aborted) {
			throw new DOMException('The queued input save was cancelled.', 'AbortError');
		}

		return updateSessionSetInputValuesWithDatabase(
			database,
			sessionSetId,
			{ [field]: rawValue },
			intent?.updatedAt,
			intent ? { [field]: intent.baseValue } : {},
			{ resumeAbandoned: true }
		);
	});

	return {
		sessionSet: result.sessionSet,
		skipped: result.skippedFields.includes(field)
	};
}
export async function flushSessionInputDraftWithDatabase(
	database: SessionInputDatabase,
	sessionId: string,
	options: { clearDraft?: boolean } = {},
	ownerId?: string
) {
	const draft = readSessionInputDraft(sessionId, ownerId);

	if (!draft?.sets) {
		return;
	}

	const rawDraftEntries = Object.entries(draft.sets);
	const draftEntries = rawDraftEntries.filter((entry): entry is [string, SessionInputDraftSet] =>
		isSessionInputDraftSet(entry[1])
	);
	const staleSetIds = new Set(
		rawDraftEntries
			.filter(([, draftSet]) => !isSessionInputDraftSet(draftSet))
			.map(([sessionSetId]) => sessionSetId)
	);
	const unresolvedDraftSets: Record<string, SessionInputDraftSet> = {};
	let discardedMissingSetDraft = false;

	if (draftEntries.length === 0) {
		if (options.clearDraft !== false) {
			finalizeSessionInputDraftIfUnchanged(draft, null, ownerId);
		}
		return;
	}

	const existingSets = await database.sessionSets.bulkGet(
		draftEntries.map(([sessionSetId]) => sessionSetId)
	);
	const existingSetIds = new Set(
		existingSets.flatMap((sessionSet) => (sessionSet ? [sessionSet.id] : []))
	);

	for (const [sessionSetId] of draftEntries) {
		if (!existingSetIds.has(sessionSetId)) {
			staleSetIds.add(sessionSetId);
		}
	}

	for (const [sessionSetId, draftSet] of draftEntries) {
		if (staleSetIds.has(sessionSetId)) {
			discardedMissingSetDraft = true;
			continue;
		}

		const rawValues: Partial<Record<SessionInputField, string>> = {};
		const baseValues: Partial<Record<SessionInputField, string>> = {};
		const activityByField: Partial<Record<SessionInputField, number>> = {};

		for (const field of ['weight', 'reps', 'rir'] as const) {
			const fieldKey = `${field}Input` as const;
			const baseKey = `${fieldKey}Base` as const;
			const intentAtKey = `${fieldKey}IntentAt` as SessionInputFieldIntentAtKey;

			if (Object.hasOwn(draftSet, fieldKey)) {
				rawValues[field] = draftSet[fieldKey] ?? '';
				activityByField[field] = draftSet[intentAtKey] ?? draftSet.updatedAt ?? draft.updatedAt;

				if (Object.hasOwn(draftSet, baseKey)) {
					baseValues[field] = draftSet[baseKey] ?? '';
				}
			}
		}

		try {
			const { skippedFields } = await updateSessionSetInputValuesWithDatabase(
				database,
				sessionSetId,
				rawValues,
				activityByField,
				baseValues
			);

			if (skippedFields.length > 0) {
				const unresolvedDraftSet: SessionInputDraftSet = {
					updatedAt: draftSet.updatedAt ?? draft.updatedAt
				};

				for (const field of skippedFields) {
					const fieldKey = `${field}Input` as const;
					const baseKey = `${fieldKey}Base` as const;
					const intentAtKey = `${fieldKey}IntentAt` as SessionInputFieldIntentAtKey;
					const versionKey = `${fieldKey}Version` as SessionInputFieldVersionKey;
					unresolvedDraftSet[fieldKey] = draftSet[fieldKey] ?? '';
					unresolvedDraftSet[intentAtKey] =
						activityByField[field] ?? draftSet.updatedAt ?? draft.updatedAt;

					if (Object.hasOwn(draftSet, baseKey)) {
						unresolvedDraftSet[baseKey] = draftSet[baseKey] ?? '';
					}

					if (Object.hasOwn(draftSet, versionKey)) {
						unresolvedDraftSet[versionKey] = draftSet[versionKey] ?? '';
					}
				}

				unresolvedDraftSets[sessionSetId] = unresolvedDraftSet;
			}
		} catch (error) {
			if (error instanceof Error && error.message === 'Set not found.') {
				discardedMissingSetDraft = true;
				continue;
			}

			throw error;
		}
	}

	if (options.clearDraft !== false) {
		if (Object.keys(unresolvedDraftSets).length > 0) {
			finalizeSessionInputDraftIfUnchanged(
				draft,
				{
					...draft,
					sets: unresolvedDraftSets
				},
				ownerId
			);
			throw new Error(
				discardedMissingSetDraft
					? 'Some workout inputs changed on another device, and a removed set could not be restored. Your remaining unsaved values were kept; review and edit them again.'
					: 'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
			);
		}

		finalizeSessionInputDraftIfUnchanged(draft, null, ownerId);

		if (discardedMissingSetDraft) {
			throw new Error(
				'A set was removed on another device, so its unsaved inputs could not be applied. The rest of your session is safe.'
			);
		}
	}
}

export async function flushSessionInputDraft(
	sessionId: string,
	options: { clearDraft?: boolean } = {}
) {
	requireLoggedInUser();
	return runAuthenticatedDatabaseOperation(({ userId, database }) =>
		flushSessionInputDraftWithDatabase(database, sessionId, options, userId)
	);
}
