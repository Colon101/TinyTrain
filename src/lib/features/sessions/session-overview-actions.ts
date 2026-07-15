import { writable } from 'svelte/store';
import type { SessionOverview, SessionStatus } from '$lib/db';
import { getResolvedAuthOwnerId } from '$lib/auth-owned-state';

export type SessionOverviewTimerSummary = Pick<
	SessionOverview['summary'],
	'id' | 'status' | 'startedAt' | 'completedAt' | 'workoutNameSnapshot' | 'dayKey'
>;

export const SESSION_EDIT_DRAFT_PREFIX = 'tinytrain:session-edit-draft:';
const SESSION_EDIT_DRAFT_MIGRATION_PREFIX = 'tinytrain:session-edit-draft-migrated:';
export const SESSION_EDIT_DISCARD_MESSAGE =
	'Discard your edit mode changes? Unsaved time changes will be lost.';

export type SessionEditDraft = {
	startedAt: string;
	completedAt: string;
	baseStartedAt?: string;
	baseCompletedAt?: string;
};

export function getSessionEditDraftKey(sessionId: string) {
	const ownerId = getResolvedAuthOwnerId();

	return ownerId
		? `${SESSION_EDIT_DRAFT_PREFIX}${encodeURIComponent(ownerId)}:${sessionId}`
		: getLegacySessionEditDraftKey(sessionId);
}

export function getLegacySessionEditDraftKey(sessionId: string) {
	return `${SESSION_EDIT_DRAFT_PREFIX}${sessionId}`;
}

function getSessionEditDraftMigrationKey(ownerId: string, sessionId: string) {
	return `${SESSION_EDIT_DRAFT_MIGRATION_PREFIX}${encodeURIComponent(ownerId)}:${sessionId}`;
}

function getSessionEditDraftRecoveryKey(ownerId: string, sessionId: string) {
	return `${SESSION_EDIT_DRAFT_MIGRATION_PREFIX}recovery:${encodeURIComponent(ownerId)}:${sessionId}`;
}

function getSessionEditDraftLegacyClaimKey(ownerId: string, sessionId: string) {
	return `${SESSION_EDIT_DRAFT_MIGRATION_PREFIX}legacy-checked:${encodeURIComponent(
		ownerId
	)}:${encodeURIComponent(sessionId)}`;
}

function getSessionDraftStorage() {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function getLegacySessionDraftStorage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function parseSessionEditDraft(rawDraft: string | null): SessionEditDraft | null {
	try {
		const parsedDraft = rawDraft ? (JSON.parse(rawDraft) as Partial<SessionEditDraft>) : null;

		if (
			parsedDraft &&
			typeof parsedDraft.startedAt === 'string' &&
			typeof parsedDraft.completedAt === 'string'
		) {
			const draft: SessionEditDraft = {
				startedAt: parsedDraft.startedAt,
				completedAt: parsedDraft.completedAt
			};

			if (
				typeof parsedDraft.baseStartedAt === 'string' &&
				typeof parsedDraft.baseCompletedAt === 'string'
			) {
				draft.baseStartedAt = parsedDraft.baseStartedAt;
				draft.baseCompletedAt = parsedDraft.baseCompletedAt;
			}

			return draft;
		}
	} catch {
		// Invalid optional storage is ignored without blocking the edit flow.
	}

	return null;
}

export function readSessionEditDraft(sessionId: string): SessionEditDraft | null {
	const ownerId = getResolvedAuthOwnerId();

	if (!ownerId) {
		return null;
	}

	const draftKey = getSessionEditDraftKey(sessionId);
	const migrationKey = getSessionEditDraftMigrationKey(ownerId, sessionId);
	const sessionStorage = getSessionDraftStorage();

	if (sessionStorage) {
		try {
			const sessionDraft = parseSessionEditDraft(sessionStorage.getItem(draftKey));

			if (sessionDraft) {
				return sessionDraft;
			}

			if (sessionStorage.getItem(migrationKey) === '1') {
				return null;
			}
		} catch {
			// Fall through to the pre-upgrade local draft when session storage is unavailable.
		}
	}

	const recoveryStorage = getLegacySessionDraftStorage();
	let recoveryDraft: SessionEditDraft | null;

	try {
		recoveryDraft = parseSessionEditDraft(
			recoveryStorage?.getItem(getSessionEditDraftRecoveryKey(ownerId, sessionId)) ?? null
		);
	} catch {
		return null;
	}

	if (!recoveryDraft) {
		return null;
	}

	if (sessionStorage) {
		try {
			sessionStorage.setItem(draftKey, JSON.stringify(recoveryDraft));
			sessionStorage.setItem(migrationKey, '1');
		} catch {
			// Returning the legacy draft still lets the user recover it for this edit attempt.
		}
	}

	return recoveryDraft;
}

/** Claims an unscoped timing draft only after this owner's database confirms the session. */
export function migrateLegacySessionEditDraftForCurrentUser(sessionId: string) {
	const ownerId = getResolvedAuthOwnerId();

	if (!ownerId) {
		return false;
	}

	const sessionStorage = getSessionDraftStorage();
	const legacyStorage = getLegacySessionDraftStorage();
	const legacyKey = getLegacySessionEditDraftKey(sessionId);
	const migrationKey = getSessionEditDraftMigrationKey(ownerId, sessionId);
	const legacyClaimKey = getSessionEditDraftLegacyClaimKey(ownerId, sessionId);

	try {
		if (legacyStorage?.getItem(legacyClaimKey) === '1') {
			return false;
		}
	} catch {
		// A current-tab owner-scoped draft still takes precedence below.
	}

	let ownerDraftAlreadyHandled = Boolean(readSessionEditDraft(sessionId));

	try {
		ownerDraftAlreadyHandled ||= sessionStorage?.getItem(migrationKey) === '1';
	} catch {
		// Continue without allowing a storage failure to expose an unscoped draft early.
	}

	if (ownerDraftAlreadyHandled) {
		try {
			legacyStorage?.setItem(legacyClaimKey, '1');
		} catch {
			// The owner-scoped draft remains authoritative in this tab.
		}
		return false;
	}

	let legacyDraft: SessionEditDraft | null;

	try {
		legacyDraft =
			parseSessionEditDraft(sessionStorage?.getItem(legacyKey) ?? null) ??
			parseSessionEditDraft(legacyStorage?.getItem(legacyKey) ?? null);
	} catch {
		return false;
	}

	if (!legacyDraft) {
		try {
			legacyStorage?.setItem(legacyClaimKey, '1');
		} catch {
			// A later confirmed load can repeat the harmless legacy check.
		}
		return false;
	}

	const recoveryKey = getSessionEditDraftRecoveryKey(ownerId, sessionId);
	let recovered = false;

	try {
		legacyStorage?.setItem(recoveryKey, JSON.stringify(legacyDraft));
		recovered = Boolean(legacyStorage);
	} catch {
		// The current tab can still own the migration when session storage succeeds.
	}

	try {
		sessionStorage?.setItem(getSessionEditDraftKey(sessionId), JSON.stringify(legacyDraft));
		sessionStorage?.setItem(getSessionEditDraftMigrationKey(ownerId, sessionId), '1');
		recovered = recovered || Boolean(sessionStorage);
	} catch {
		// Keep the unscoped recovery copy when no owner-scoped destination was durable.
	}

	if (!recovered) {
		return false;
	}

	try {
		legacyStorage?.setItem(legacyClaimKey, '1');
	} catch {
		// The durable owner-scoped recovery copy is sufficient.
	}

	try {
		sessionStorage?.removeItem(legacyKey);
		legacyStorage?.removeItem(legacyKey);
	} catch {
		// Owner-scoped copies are already durable; stale legacy data remains quarantined.
	}

	return true;
}

export function writeSessionEditDraft(sessionId: string, draft: SessionEditDraft) {
	const ownerId = getResolvedAuthOwnerId();

	if (!ownerId) {
		return;
	}

	try {
		const sessionStorage = getSessionDraftStorage();

		sessionStorage?.setItem(getSessionEditDraftKey(sessionId), JSON.stringify(draft));
		sessionStorage?.setItem(getSessionEditDraftMigrationKey(ownerId, sessionId), '1');
	} catch {
		// Optional edit-draft persistence must not block saving or leaving edit mode.
	}
}

export function clearSessionEditDraft(sessionId: string) {
	const ownerId = getResolvedAuthOwnerId();

	if (!ownerId) {
		return;
	}

	const draftKey = getSessionEditDraftKey(sessionId);

	try {
		const sessionStorage = getSessionDraftStorage();

		sessionStorage?.setItem(getSessionEditDraftMigrationKey(ownerId, sessionId), '1');
		sessionStorage?.removeItem(draftKey);
	} catch {
		// Optional current-tab cleanup must not block the underlying action.
	}

	try {
		getLegacySessionDraftStorage()?.removeItem(getSessionEditDraftRecoveryKey(ownerId, sessionId));
	} catch {
		// A legacy cleanup failure must not block saving or leaving edit mode.
	}
}

export type SessionOverviewActions = {
	status: SessionStatus;
	timerSummary: SessionOverviewTimerSummary;
	isEditMode: boolean;
	canEditSession: boolean;
	canEditTime: boolean;
	hasUnsavedChanges: boolean;
	isSaving: boolean;
	isSharingSession: boolean;
	onEnterEditMode: () => void;
	onSaveEditMode: () => void | Promise<void>;
	onDiscardEditMode: () => void | Promise<void>;
	onOpenTimeEditor: () => void;
	onShareSession: () => void | Promise<void>;
	onEndSession: () => void;
	onResetSession: () => void;
	onDeleteSession: () => void;
};

export const sessionOverviewActions = writable<SessionOverviewActions | null>(null);

export function setSessionOverviewActions(actions: SessionOverviewActions) {
	sessionOverviewActions.set(actions);
}

export function clearSessionOverviewActions() {
	sessionOverviewActions.set(null);
}
