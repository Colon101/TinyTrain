import type { SessionInputField, SessionOverview, SessionSetOverview } from '$lib/db';
import { createFieldDelta } from '$lib/db/shared';
import {
	clearSessionInputDraft,
	createEmptySessionInputDraft,
	getSessionInputDraftKey,
	isSessionInputDraftSet,
	migrateLegacySessionInputDraftForCurrentUser,
	readSessionInputDraft,
	SESSION_INPUT_DRAFT_CHANGE_EVENT,
	writeSessionInputDraft,
	type SessionInputDraft,
	type SessionInputDraftSet,
	type SessionInputFieldBaseKey,
	type SessionInputFieldKey
} from '$lib/db/session-drafts';

export {
	clearSessionInputDraft,
	createEmptySessionInputDraft,
	getSessionInputDraftKey,
	migrateLegacySessionInputDraftForCurrentUser,
	readSessionInputDraft,
	SESSION_INPUT_DRAFT_CHANGE_EVENT,
	writeSessionInputDraft
};
export type {
	SessionInputDraft,
	SessionInputDraftSet,
	SessionInputFieldBaseKey,
	SessionInputFieldKey
};
type ApplySessionInputDraftOptions = {
	includeCompleted?: boolean;
};

export function getSessionInputFieldKey(field: SessionInputField): SessionInputFieldKey {
	return `${field}Input`;
}

export function getSessionInputFieldBaseKey(field: SessionInputField): SessionInputFieldBaseKey {
	return `${getSessionInputFieldKey(field)}Base`;
}

export function parseSessionInputValue(rawValue: string) {
	if (!rawValue.trim()) {
		return undefined;
	}

	const nextValue = Number(rawValue.trim());

	return Number.isFinite(nextValue) ? nextValue : undefined;
}

export function rebuildSessionSetOverview(
	sessionSet: SessionSetOverview,
	overrides: Partial<SessionSetOverview>
): SessionSetOverview {
	const nextSet = {
		...sessionSet,
		...overrides
	};

	return {
		...nextSet,
		weightDelta: createFieldDelta(nextSet.weight, nextSet.previousReference?.weight),
		repsDelta: createFieldDelta(nextSet.reps, nextSet.previousReference?.reps),
		rirDelta: createFieldDelta(nextSet.rir, nextSet.previousReference?.rir)
	};
}

export function applySessionInputDraft(
	nextOverview: SessionOverview | null,
	draft = nextOverview ? readSessionInputDraft(nextOverview.summary.id) : null,
	options: ApplySessionInputDraftOptions = {}
) {
	const canApplyDraft =
		nextOverview?.summary.status === 'in_progress' ||
		(options.includeCompleted === true && nextOverview?.summary.status === 'completed');

	if (!nextOverview || !canApplyDraft || !draft || draft.sessionId !== nextOverview.summary.id) {
		return nextOverview;
	}

	return {
		...nextOverview,
		exercises: nextOverview.exercises.map((sessionExercise) => ({
			...sessionExercise,
			sets: (sessionExercise.sets as SessionSetOverview[]).map((sessionSet) =>
				applyDraftToSessionSet(sessionSet, draft)
			)
		}))
	};
}

function hasDraftInputValue(
	draftSet: SessionInputDraftSet | undefined,
	fieldKey: SessionInputFieldKey
) {
	return Boolean(draftSet && Object.hasOwn(draftSet, fieldKey));
}

function applyDraftToSessionSet(sessionSet: SessionSetOverview, draft: SessionInputDraft) {
	const draftSet = draft.sets[sessionSet.id];
	const overrides: Partial<SessionSetOverview> = {};

	if (!isSessionInputDraftSet(draftSet)) {
		return sessionSet;
	}

	for (const field of ['weight', 'reps', 'rir'] as const) {
		const fieldKey = getSessionInputFieldKey(field);

		if (!hasDraftInputValue(draftSet, fieldKey)) {
			continue;
		}

		const rawValue = draftSet?.[fieldKey] ?? '';
		overrides[fieldKey] = rawValue;
		overrides[field] = parseSessionInputValue(rawValue);
	}

	return Object.keys(overrides).length > 0
		? rebuildSessionSetOverview(sessionSet, overrides)
		: sessionSet;
}
