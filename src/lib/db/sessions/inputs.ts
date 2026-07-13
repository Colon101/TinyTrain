import type { SessionInputField, SessionSet } from '../models';
import { db, requireLoggedInUser } from '../runtime';
import {
	clearSessionInputDraft,
	isSessionInputDraftSet,
	readSessionInputDraft,
	type SessionInputDraftSet,
	writeSessionInputDraft
} from '../session-drafts';
import {
	timestamp,
	toCleanSessionInputValue,
	toParsedInputValue,
	withSessionSetDefaults
} from '../shared';

export async function updateSessionSetInputValues(
	sessionSetId: string,
	rawValues: Partial<Record<SessionInputField, string>>,
	requestedActivityMs?: number,
	baseValues: Partial<Record<SessionInputField, string>> = {}
) {
	let nextSet: SessionSet | null = null;
	const skippedFields: SessionInputField[] = [];

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		const sessionSet = await db.sessionSets.get(sessionSetId);

		if (!sessionSet) {
			throw new Error('Set not found.');
		}

		const normalizedSet = withSessionSetDefaults(sessionSet);
		const patch: Partial<SessionSet> = {};
		const nowMs = Date.now();
		const hasValidRequestedActivity =
			typeof requestedActivityMs === 'number' && Number.isFinite(requestedActivityMs);
		const requestedMs = hasValidRequestedActivity ? requestedActivityMs : nowMs;
		const boundedActivityMs = Math.min(requestedMs, nowMs);
		const currentUpdatedAtMs = new Date(sessionSet.updatedAt).getTime();
		const storedRowIsNewer =
			requestedActivityMs !== undefined &&
			(!hasValidRequestedActivity ||
				(Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs > boundedActivityMs));

		for (const field of ['weight', 'reps', 'rir'] as const) {
			if (!Object.hasOwn(rawValues, field)) {
				continue;
			}

			const inputKey = `${field}Input` as const;
			const cleanInputValue = toCleanSessionInputValue(rawValues[field] ?? '', field);
			const parsedValue = toParsedInputValue(cleanInputValue, field);

			if (normalizedSet[inputKey] === cleanInputValue && normalizedSet[field] === parsedValue) {
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
		}

		if (Object.keys(patch).length === 0) {
			nextSet = normalizedSet;
			return;
		}

		const createdAtMs = new Date(sessionSet.createdAt).getTime();
		const activityMs = Number.isFinite(createdAtMs)
			? Math.max(boundedActivityMs, createdAtMs)
			: boundedActivityMs;
		const storedActivityMs =
			Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs > activityMs
				? currentUpdatedAtMs
				: activityMs;
		const updatedAt = timestamp(new Date(storedActivityMs));
		patch.updatedAt = updatedAt;

		await db.sessionSets.update(sessionSetId, patch);

		const sessionExercise = await db.sessionExercises.get(sessionSet.sessionExerciseId);
		const session = sessionExercise
			? await db.workoutSessions.get(sessionExercise.sessionId)
			: undefined;

		if (session?.status === 'in_progress') {
			const sessionUpdatedAtMs = new Date(session.updatedAt).getTime();
			await db.workoutSessions.update(session.id, {
				updatedAt:
					Number.isFinite(sessionUpdatedAtMs) && sessionUpdatedAtMs > storedActivityMs
						? session.updatedAt
						: updatedAt
			});
		} else if (session?.status === 'abandoned' && requestedActivityMs === undefined) {
			// A live edit that was already queued when the timeout fired wins the race.
			await db.workoutSessions.update(session.id, {
				status: 'in_progress',
				completedAt: undefined,
				updatedAt
			});
		}

		nextSet = withSessionSetDefaults({ ...sessionSet, ...patch });
	});

	if (!nextSet) {
		throw new Error('Set not found.');
	}

	return { sessionSet: nextSet, skippedFields };
}

export async function updateSessionSetInputs(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string
) {
	return (await updateSessionSetInputValues(sessionSetId, { [field]: rawValue })).sessionSet;
}
export async function flushSessionInputDraft(
	sessionId: string,
	options: { clearDraft?: boolean } = {}
) {
	requireLoggedInUser();

	const draft = readSessionInputDraft(sessionId);

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
			clearSessionInputDraft(sessionId);
		}
		return;
	}

	const existingSets = await db.sessionSets.bulkGet(
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

		for (const field of ['weight', 'reps', 'rir'] as const) {
			const fieldKey = `${field}Input` as const;
			const baseKey = `${fieldKey}Base` as const;

			if (Object.hasOwn(draftSet, fieldKey)) {
				rawValues[field] = draftSet[fieldKey] ?? '';

				if (Object.hasOwn(draftSet, baseKey)) {
					baseValues[field] = draftSet[baseKey] ?? '';
				}
			}
		}

		try {
			const { skippedFields } = await updateSessionSetInputValues(
				sessionSetId,
				rawValues,
				draftSet.updatedAt ?? draft.updatedAt,
				baseValues
			);

			if (skippedFields.length > 0) {
				const unresolvedDraftSet: SessionInputDraftSet = {
					updatedAt: draftSet.updatedAt ?? draft.updatedAt
				};

				for (const field of skippedFields) {
					const fieldKey = `${field}Input` as const;
					const baseKey = `${fieldKey}Base` as const;
					unresolvedDraftSet[fieldKey] = draftSet[fieldKey] ?? '';

					if (Object.hasOwn(draftSet, baseKey)) {
						unresolvedDraftSet[baseKey] = draftSet[baseKey] ?? '';
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
			writeSessionInputDraft({
				...draft,
				sets: unresolvedDraftSets
			});
			throw new Error(
				discardedMissingSetDraft
					? 'Some workout inputs changed on another device, and a removed set could not be restored. Your remaining unsaved values were kept; review and edit them again.'
					: 'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
			);
		}

		clearSessionInputDraft(sessionId);

		if (discardedMissingSetDraft) {
			throw new Error(
				'A set was removed on another device, so its unsaved inputs could not be applied. The rest of your session is safe.'
			);
		}
	}
}
