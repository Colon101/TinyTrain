import { browser } from '$app/environment';
import type {
	SessionFieldDelta,
	SessionInputField,
	SessionOverview,
	SessionSetOverview
} from '$lib/db';

export type SessionInputFieldKey = `${SessionInputField}Input`;
export type SessionInputFieldBaseKey = `${SessionInputFieldKey}Base`;
export type SessionInputDraftSet = Partial<
	Record<SessionInputFieldKey | SessionInputFieldBaseKey, string>
> & {
	updatedAt?: number;
};
export type SessionInputDraft = {
	sessionId: string;
	sets: Record<string, SessionInputDraftSet>;
	updatedAt: number;
};
export const SESSION_INPUT_DRAFT_CHANGE_EVENT = 'tinytrain:session-input-draft-change';
const SESSION_INPUT_DRAFT_SET_STRING_KEYS = [
	'weightInput',
	'weightInputBase',
	'repsInput',
	'repsInputBase',
	'rirInput',
	'rirInputBase'
] as const satisfies readonly (SessionInputFieldKey | SessionInputFieldBaseKey)[];
type ApplySessionInputDraftOptions = {
	includeCompleted?: boolean;
};

function notifySessionInputDraftChange(sessionId: string) {
	window.dispatchEvent(
		new CustomEvent(SESSION_INPUT_DRAFT_CHANGE_EVENT, { detail: { sessionId } })
	);
}

export function getSessionInputDraftKey(sessionId: string) {
	return `tinytrain:session-input-draft:${sessionId}`;
}

export function createEmptySessionInputDraft(sessionId: string): SessionInputDraft {
	return {
		sessionId,
		sets: {},
		updatedAt: Date.now()
	};
}

export function readSessionInputDraft(sessionId: string) {
	if (!browser) {
		return null;
	}

	try {
		const rawDraft = localStorage.getItem(getSessionInputDraftKey(sessionId));
		const parsedDraft = rawDraft ? (JSON.parse(rawDraft) as Partial<SessionInputDraft>) : null;

		if (
			!parsedDraft ||
			parsedDraft.sessionId !== sessionId ||
			!parsedDraft.sets ||
			typeof parsedDraft.sets !== 'object' ||
			Array.isArray(parsedDraft.sets)
		) {
			return null;
		}

		const sets = Object.fromEntries(
			Object.entries(parsedDraft.sets).filter((entry): entry is [string, SessionInputDraftSet] =>
				isSessionInputDraftSet(entry[1])
			)
		);

		return {
			sessionId,
			sets,
			updatedAt:
				typeof parsedDraft.updatedAt === 'number' && Number.isFinite(parsedDraft.updatedAt)
					? parsedDraft.updatedAt
					: Date.now()
		};
	} catch {
		return null;
	}
}

export function writeSessionInputDraft(draft: SessionInputDraft) {
	if (!browser) {
		return;
	}

	try {
		localStorage.setItem(getSessionInputDraftKey(draft.sessionId), JSON.stringify(draft));
		notifySessionInputDraftChange(draft.sessionId);
	} catch {
		// Optional draft persistence must never interrupt rapid workout input.
	}
}

export function clearSessionInputDraft(sessionId: string) {
	if (!browser) {
		return;
	}

	try {
		localStorage.removeItem(getSessionInputDraftKey(sessionId));
		notifySessionInputDraftChange(sessionId);
	} catch {
		// Optional draft cleanup must never block the underlying workout mutation.
	}
}

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
		weightDelta: createSessionFieldDelta(nextSet.weight, nextSet.previousReference?.weight),
		repsDelta: createSessionFieldDelta(nextSet.reps, nextSet.previousReference?.reps),
		rirDelta: createSessionFieldDelta(nextSet.rir, nextSet.previousReference?.rir)
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

function isSessionInputDraftSet(value: unknown): value is SessionInputDraftSet {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	const hasValidStringFields = SESSION_INPUT_DRAFT_SET_STRING_KEYS.every(
		(key) => !Object.hasOwn(candidate, key) || typeof candidate[key] === 'string'
	);
	const hasValidUpdatedAt =
		!Object.hasOwn(candidate, 'updatedAt') ||
		(typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt));

	return hasValidStringFields && hasValidUpdatedAt;
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

function formatSignedDelta(diff: number) {
	return `${diff > 0 ? '+' : ''}${Number(diff.toFixed(2))}`;
}

function createSessionFieldDelta(current?: number, previous?: number): SessionFieldDelta {
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
