export type AuthOwnedStateIdentity = Readonly<{
	ownerId: string | null;
	generation: number;
	isResolved: boolean;
}>;

let identity: AuthOwnedStateIdentity = Object.freeze({
	ownerId: null,
	generation: 0,
	isResolved: false
});
const volatileInvalidators = new Set<() => void>();

export function getAuthOwnedStateIdentity() {
	return identity;
}

export function isAuthOwnedStateIdentityCurrent(candidate: AuthOwnedStateIdentity) {
	return identity === candidate;
}

export function getResolvedAuthOwnerId() {
	return identity.isResolved ? identity.ownerId : null;
}

export function setAuthOwnedStateIdentity(ownerId: string | null, isResolved: boolean) {
	const nextOwnerId = isResolved ? ownerId : null;

	if (identity.ownerId === nextOwnerId && identity.isResolved === isResolved) {
		return;
	}

	identity = Object.freeze({
		ownerId: nextOwnerId,
		generation: identity.generation + 1,
		isResolved
	});

	for (const invalidate of volatileInvalidators) {
		invalidate();
	}
}

export function registerAuthOwnedVolatileInvalidator(invalidate: () => void) {
	volatileInvalidators.add(invalidate);

	return () => volatileInvalidators.delete(invalidate);
}
