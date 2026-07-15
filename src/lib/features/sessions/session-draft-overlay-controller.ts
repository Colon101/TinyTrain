import {
	getAuthOwnedStateIdentity,
	registerAuthOwnedVolatileInvalidator,
	type AuthOwnedStateIdentity
} from '$lib/auth-owned-state';
import type { SessionOverview } from '$lib/db';
import {
	applySessionInputDraft,
	isSessionInputDraftStorageKey,
	readSessionInputDraft,
	SESSION_INPUT_DRAFT_CHANGE_EVENT,
	type SessionInputDraft
} from './session-input-draft';

export type SessionDraftOverlaySnapshot = Readonly<{
	sessionId: string;
	ownerId: string | null;
	authGeneration: number;
	isOwnerResolved: boolean;
	baseline: SessionOverview | null;
	draft: SessionInputDraft | null;
	overview: SessionOverview | null;
}>;

export type SessionDraftOverlayOwnerScope = Readonly<{
	ownerId: string | null;
	authGeneration: number;
	isOwnerResolved: boolean;
}>;

export type SessionDraftOverlayController = {
	getSnapshot: () => SessionDraftOverlaySnapshot;
	getOwnerScope: () => SessionDraftOverlayOwnerScope;
	isCurrentOwnerScope: (scope: SessionDraftOverlayOwnerScope) => boolean;
	setBaseline: (
		baseline: SessionOverview | null,
		expectedOwnerScope?: SessionDraftOverlayOwnerScope
	) => SessionDraftOverlaySnapshot;
	setIncludeCompleted: (includeCompleted: boolean) => SessionDraftOverlaySnapshot;
	refreshDraft: () => SessionDraftOverlaySnapshot;
	subscribe: (listener: (snapshot: SessionDraftOverlaySnapshot) => void) => () => void;
	dispose: () => void;
};

type SessionDraftOverlayEventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type SessionDraftOverlayControllerOptions = {
	sessionId: string;
	includeCompleted?: boolean;
	eventSource?: SessionDraftOverlayEventSource | null;
	getOwnerIdentity?: () => AuthOwnedStateIdentity;
	registerOwnerInvalidator?: (invalidate: () => void) => () => void;
	readDraft?: (sessionId: string) => SessionInputDraft | null;
	isDraftStorageKey?: (sessionId: string, storageKey: string | null) => boolean;
	applyDraft?: (
		baseline: SessionOverview | null,
		draft: SessionInputDraft | null,
		options: { includeCompleted: boolean }
	) => SessionOverview | null;
};

function getDefaultEventSource() {
	return typeof window === 'undefined' ? null : window;
}

function sameOwnerScope(first: AuthOwnedStateIdentity, second: AuthOwnedStateIdentity) {
	return (
		first.ownerId === second.ownerId &&
		first.generation === second.generation &&
		first.isResolved === second.isResolved
	);
}

function ownerIdentityMatchesScope(
	identity: AuthOwnedStateIdentity,
	scope: SessionDraftOverlayOwnerScope
) {
	return (
		identity.ownerId === scope.ownerId &&
		identity.generation === scope.authGeneration &&
		identity.isResolved === scope.isOwnerResolved
	);
}

/**
 * Keeps the database/cache result separate from the current durable input journal. Every visible
 * value is rebuilt from that clean baseline, so replacing or clearing a cross-tab draft can never
 * inherit fields from the previous overlay.
 */
export function createSessionDraftOverlayController({
	sessionId,
	includeCompleted: initialIncludeCompleted = false,
	eventSource = getDefaultEventSource(),
	getOwnerIdentity = getAuthOwnedStateIdentity,
	registerOwnerInvalidator = registerAuthOwnedVolatileInvalidator,
	readDraft = readSessionInputDraft,
	isDraftStorageKey = isSessionInputDraftStorageKey,
	applyDraft = applySessionInputDraft
}: SessionDraftOverlayControllerOptions): SessionDraftOverlayController {
	let disposed = false;
	let includeCompleted = initialIncludeCompleted;
	let ownerIdentity = getOwnerIdentity();
	let baseline: SessionOverview | null = null;
	let draft = readCurrentOwnerDraft();
	let snapshot = buildSnapshot();
	const listeners = new Set<(snapshot: SessionDraftOverlaySnapshot) => void>();

	function readCurrentOwnerDraft() {
		if (!ownerIdentity.isResolved || !ownerIdentity.ownerId) {
			return null;
		}

		const nextDraft = readDraft(sessionId);

		return nextDraft?.sessionId === sessionId ? nextDraft : null;
	}

	function buildSnapshot(): SessionDraftOverlaySnapshot {
		const canExposeBaseline = ownerIdentity.isResolved && Boolean(ownerIdentity.ownerId);
		const cleanBaseline = canExposeBaseline ? baseline : null;

		return {
			sessionId,
			ownerId: canExposeBaseline ? ownerIdentity.ownerId : null,
			authGeneration: ownerIdentity.generation,
			isOwnerResolved: ownerIdentity.isResolved,
			baseline: cleanBaseline,
			draft: canExposeBaseline ? draft : null,
			overview: applyDraft(cleanBaseline, canExposeBaseline ? draft : null, {
				includeCompleted
			})
		};
	}

	function getOwnerScope(): SessionDraftOverlayOwnerScope {
		return {
			ownerId: ownerIdentity.isResolved ? ownerIdentity.ownerId : null,
			authGeneration: ownerIdentity.generation,
			isOwnerResolved: ownerIdentity.isResolved
		};
	}

	function publish() {
		snapshot = buildSnapshot();

		for (const listener of listeners) {
			listener(snapshot);
		}

		return snapshot;
	}

	function synchronizeOwnerScope() {
		const nextIdentity = getOwnerIdentity();

		if (sameOwnerScope(ownerIdentity, nextIdentity)) {
			return false;
		}

		ownerIdentity = nextIdentity;
		// A baseline is database-owned state too. Never retain it through an auth generation change,
		// even when the next owner happens to use the same session id.
		baseline = null;
		draft = readCurrentOwnerDraft();
		return true;
	}

	function refreshDraft() {
		if (disposed) {
			return snapshot;
		}

		const ownerChanged = synchronizeOwnerScope();

		if (!ownerChanged) {
			draft = readCurrentOwnerDraft();
		}

		return publish();
	}

	function handleDraftEvent(event: Event) {
		if (disposed) {
			return;
		}

		if (synchronizeOwnerScope()) {
			publish();
		}

		if (event.type === 'storage') {
			if (!isDraftStorageKey(sessionId, (event as StorageEvent).key ?? null)) {
				return;
			}
		} else {
			const detail = (event as CustomEvent<{ sessionId?: string }>).detail;

			if (detail?.sessionId !== sessionId) {
				return;
			}
		}

		refreshDraft();
	}

	eventSource?.addEventListener(SESSION_INPUT_DRAFT_CHANGE_EVENT, handleDraftEvent);
	eventSource?.addEventListener('storage', handleDraftEvent);
	const unregisterOwnerInvalidator = eventSource
		? registerOwnerInvalidator(refreshDraft)
		: () => undefined;

	return {
		getSnapshot() {
			if (!disposed && synchronizeOwnerScope()) {
				return publish();
			}

			return snapshot;
		},
		getOwnerScope() {
			if (!disposed && synchronizeOwnerScope()) {
				publish();
			}

			return getOwnerScope();
		},
		isCurrentOwnerScope(scope) {
			if (!disposed && synchronizeOwnerScope()) {
				publish();
			}

			return ownerIdentityMatchesScope(ownerIdentity, scope);
		},
		setBaseline(nextBaseline, expectedOwnerScope) {
			if (disposed) {
				return snapshot;
			}

			const ownerChanged = synchronizeOwnerScope();

			if (expectedOwnerScope && !ownerIdentityMatchesScope(ownerIdentity, expectedOwnerScope)) {
				return ownerChanged ? publish() : snapshot;
			}

			baseline = ownerIdentity.isResolved && ownerIdentity.ownerId ? nextBaseline : null;
			// A database response and a storage event can cross. Re-read the journal at the point the
			// clean response becomes current so neither ordering can temporarily hide durable input.
			draft = readCurrentOwnerDraft();
			return publish();
		},
		setIncludeCompleted(nextIncludeCompleted) {
			if (disposed || includeCompleted === nextIncludeCompleted) {
				return snapshot;
			}

			includeCompleted = nextIncludeCompleted;
			return publish();
		},
		refreshDraft,
		subscribe(listener) {
			if (disposed) {
				listener(snapshot);
				return () => undefined;
			}

			listeners.add(listener);
			listener(snapshot);

			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			if (disposed) {
				return;
			}

			disposed = true;
			eventSource?.removeEventListener(SESSION_INPUT_DRAFT_CHANGE_EVENT, handleDraftEvent);
			eventSource?.removeEventListener('storage', handleDraftEvent);
			unregisterOwnerInvalidator();
			listeners.clear();
		}
	};
}
