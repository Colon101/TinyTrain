import { browser } from '$app/environment';
import { SESSION_INPUT_DRAFT_CHANGE_EVENT } from '../features/sessions/session-input-draft';
import type { SessionInputField } from './models';

type SessionInputDraftFieldKey = `${SessionInputField}Input`;
type SessionInputDraftBaseKey = `${SessionInputDraftFieldKey}Base`;

export type SessionInputDraftSet = Partial<
	Record<SessionInputDraftFieldKey | SessionInputDraftBaseKey, string>
> & { updatedAt?: number };

export type SessionInputDraft = {
	sessionId: string;
	sets?: Record<string, SessionInputDraftSet>;
	updatedAt?: number;
};

function getSessionInputDraftKey(sessionId: string) {
	return `tinytrain:session-input-draft:${sessionId}`;
}

export function readSessionInputDraft(sessionId: string) {
	if (!browser) {
		return null;
	}

	try {
		const rawDraft = localStorage.getItem(getSessionInputDraftKey(sessionId));
		const draft = rawDraft ? (JSON.parse(rawDraft) as SessionInputDraft) : null;

		if (!draft || draft.sessionId !== sessionId || !draft.sets) {
			return null;
		}

		return draft;
	} catch {
		return null;
	}
}

export function isSessionInputDraftSet(value: unknown): value is SessionInputDraftSet {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function clearSessionInputDraft(sessionId: string) {
	if (!browser) {
		return;
	}

	try {
		localStorage.removeItem(getSessionInputDraftKey(sessionId));
		window.dispatchEvent(
			new CustomEvent(SESSION_INPUT_DRAFT_CHANGE_EVENT, { detail: { sessionId } })
		);
	} catch {
		// Draft cleanup should not block the underlying workout mutation.
	}
}

export function writeSessionInputDraft(sessionId: string, draft: SessionInputDraft) {
	if (!browser) {
		return;
	}

	try {
		localStorage.setItem(getSessionInputDraftKey(sessionId), JSON.stringify(draft));
		window.dispatchEvent(
			new CustomEvent(SESSION_INPUT_DRAFT_CHANGE_EVENT, { detail: { sessionId } })
		);
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

	writeSessionInputDraft(sessionId, {
		...draft,
		sets: nextSets
	});
}
