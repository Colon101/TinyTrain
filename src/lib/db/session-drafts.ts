import { browser } from '$app/environment';
import type { SessionInputField } from './models';

export type SessionInputFieldKey = `${SessionInputField}Input`;
export type SessionInputFieldBaseKey = `${SessionInputFieldKey}Base`;

export type SessionInputDraftSet = Partial<
	Record<SessionInputFieldKey | SessionInputFieldBaseKey, string>
> & { updatedAt?: number };

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
		const draft = rawDraft ? (JSON.parse(rawDraft) as Partial<SessionInputDraft>) : null;

		if (
			!draft ||
			draft.sessionId !== sessionId ||
			!draft.sets ||
			typeof draft.sets !== 'object' ||
			Array.isArray(draft.sets)
		) {
			return null;
		}

		const sets = Object.fromEntries(
			Object.entries(draft.sets).filter((entry): entry is [string, SessionInputDraftSet] =>
				isSessionInputDraftSet(entry[1])
			)
		);

		return {
			sessionId,
			sets,
			updatedAt:
				typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
					? draft.updatedAt
					: Date.now()
		};
	} catch {
		return null;
	}
}

export function isSessionInputDraftSet(value: unknown): value is SessionInputDraftSet {
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

export function clearSessionInputDraft(sessionId: string) {
	if (!browser) {
		return;
	}

	try {
		localStorage.removeItem(getSessionInputDraftKey(sessionId));
		notifySessionInputDraftChange(sessionId);
	} catch {
		// Draft cleanup should not block the underlying workout mutation.
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
		// Draft persistence should not block the underlying workout mutation.
	}
}

export function removeSessionInputDraftSets(sessionId: string, sessionSetIds: string[]) {
	if (sessionSetIds.length === 0) {
		return;
	}

	const draft = readSessionInputDraft(sessionId);

	if (!draft?.sets) {
		return;
	}

	const sessionSetIdSet = new Set(sessionSetIds);
	const nextSets = Object.fromEntries(
		Object.entries(draft.sets).filter(([sessionSetId]) => !sessionSetIdSet.has(sessionSetId))
	);

	if (Object.keys(nextSets).length === Object.keys(draft.sets).length) {
		return;
	}

	if (Object.keys(nextSets).length === 0) {
		clearSessionInputDraft(sessionId);
		return;
	}

	writeSessionInputDraft({
		...draft,
		sets: nextSets
	});
}
