import { browser } from '$app/environment';
import { getResolvedAuthOwnerId } from '$lib/auth-owned-state';
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
const SESSION_INPUT_DRAFT_PREFIX = 'tinytrain:session-input-draft:';
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
	const ownerId = getResolvedAuthOwnerId();

	return ownerId
		? `${SESSION_INPUT_DRAFT_PREFIX}${encodeURIComponent(ownerId)}:${sessionId}`
		: null;
}

export function getLegacySessionInputDraftKey(sessionId: string) {
	return `${SESSION_INPUT_DRAFT_PREFIX}${sessionId}`;
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
		const draftKey = getSessionInputDraftKey(sessionId);

		if (!draftKey) {
			return null;
		}

		return parseSessionInputDraft(sessionId, localStorage.getItem(draftKey));
	} catch {
		return null;
	}
}

function parseSessionInputDraft(sessionId: string, rawDraft: string | null) {
	try {
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

		return {
			sessionId,
			sets: Object.fromEntries(
				Object.entries(draft.sets).filter((entry): entry is [string, SessionInputDraftSet] =>
					isSessionInputDraftSet(entry[1])
				)
			),
			updatedAt:
				typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
					? draft.updatedAt
					: Date.now()
		};
	} catch {
		return null;
	}
}

/** Claims the old unscoped recovery copy only after the current user's DB confirms the session. */
export function migrateLegacySessionInputDraftForCurrentUser(sessionId: string) {
	if (!browser) {
		return false;
	}

	const draftKey = getSessionInputDraftKey(sessionId);

	if (!draftKey) {
		return false;
	}

	try {
		if (parseSessionInputDraft(sessionId, localStorage.getItem(draftKey))) {
			return false;
		}

		const legacyKey = getLegacySessionInputDraftKey(sessionId);
		const legacyDraft = parseSessionInputDraft(sessionId, localStorage.getItem(legacyKey));

		if (!legacyDraft) {
			return false;
		}

		localStorage.setItem(draftKey, JSON.stringify(legacyDraft));
		localStorage.removeItem(legacyKey);
		notifySessionInputDraftChange(sessionId);
		return true;
	} catch {
		return false;
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
		const draftKey = getSessionInputDraftKey(sessionId);

		if (!draftKey) {
			return;
		}

		localStorage.removeItem(draftKey);
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
		const draftKey = getSessionInputDraftKey(draft.sessionId);

		if (!draftKey) {
			return;
		}

		localStorage.setItem(draftKey, JSON.stringify(draft));
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
