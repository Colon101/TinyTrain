const fnvOffsetBasis = 0xcbf29ce484222325n;
const fnvPrime = 0x100000001b3n;

function hashIdentityPart(value: string) {
	let hash = fnvOffsetBasis;

	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		hash ^= BigInt(codeUnit & 0xff);
		hash = BigInt.asUintN(64, hash * fnvPrime);
		hash ^= BigInt(codeUnit >>> 8);
		hash = BigInt.asUintN(64, hash * fnvPrime);
	}

	return hash.toString(16).padStart(16, '0');
}

function createScheduledRowId(kind: string, ...identityParts: Array<string | number>) {
	const identity = JSON.stringify([kind, ...identityParts]);
	const hex = `${hashIdentityPart(`tinytrain:${identity}`)}${hashIdentityPart(`${identity}:v1`)}`;
	const versionedHex = `${hex.slice(0, 12)}8${hex.slice(13)}`;
	const variantNibble = (Number.parseInt(versionedHex[16], 16) & 0x3) | 0x8;
	const uuidHex = `${versionedHex.slice(0, 16)}${variantNibble.toString(16)}${versionedHex.slice(17)}`;

	return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
}

export function getScheduledWorkoutSessionId(userId: string, dayKey: string) {
	return createScheduledRowId('workout-session', userId, dayKey);
}

export function getScheduledSessionExerciseId(
	sessionId: string,
	workoutId: string,
	exerciseId: string,
	order: number
) {
	return createScheduledRowId('session-exercise', sessionId, workoutId, exerciseId, order);
}

export function getScheduledSessionSetLogicalId(sessionExerciseId: string, order: number) {
	return createScheduledRowId('session-set', sessionExerciseId, order);
}

/**
 * The product permits an exercise only once per session. Forks from one parent revision share an
 * id, while a later remove/re-add starts from the removal's newer revision and cannot collide with
 * the old membership tombstone.
 */
export function getAddedSessionExerciseId(
	sessionId: string,
	exerciseId: string,
	baseRevision: string
) {
	return createScheduledRowId('added-session-exercise', sessionId, exerciseId, baseRevision);
}

/**
 * Reset forks built from the same workout template target the same rows. The template position is
 * included because it is part of the reset snapshot and protects against malformed duplicates.
 */
export function getResetSessionExerciseId(
	sessionId: string,
	workoutId: string,
	exerciseId: string,
	order: number
) {
	return createScheduledRowId('reset-session-exercise', sessionId, workoutId, exerciseId, order);
}

/**
 * Seed rows belong to one concrete exercise identity. Different replacement branches therefore
 * cannot collide, while retries and same-exercise forks reuse the exact same physical rows.
 * `buildSeedSessionSetRows` appends the side to this logical id.
 */
export function getSessionExerciseSeedSetLogicalId(
	sessionExerciseId: string,
	exerciseId: string,
	order: number
) {
	return createScheduledRowId('session-exercise-seed-set', sessionExerciseId, exerciseId, order);
}
