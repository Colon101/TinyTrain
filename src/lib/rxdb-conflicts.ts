import type { RxConflictHandler } from 'rxdb';
import { deepEqual } from 'rxdb/plugins/utils';
import type { SessionExercise, SessionSet, WorkoutSession } from './db/models';
import {
	mergeSessionExerciseConflict,
	mergeWorkoutSessionConflict
} from './db/session-row-conflict';
import { mergeSessionSetConflict } from './db/session-set-conflict';

type SyncedConflictRow = {
	user_id: string;
};

function resolveDeletionConflict<T extends { _deleted: boolean }>(
	assumedMasterState: T | undefined,
	realMasterState: T,
	newDocumentState: T
) {
	if (realMasterState._deleted === newDocumentState._deleted) {
		return undefined;
	}

	if (!assumedMasterState) {
		// Without a common base, only the master is known to be durable. In particular, do not let
		// an untracked local tombstone erase a row that already exists on the master.
		return realMasterState;
	}

	// A known deletion wins over an edit so removed children are not resurrected by an offline
	// writer. RxDB tombstones do not receive a fresh application-level updatedAt timestamp.
	return realMasterState._deleted ? realMasterState : newDocumentState;
}

export const workoutSessionConflictHandler: RxConflictHandler<WorkoutSession & SyncedConflictRow> =
	{
		isEqual: deepEqual,
		async resolve({ assumedMasterState, realMasterState, newDocumentState }) {
			const deletionResolution = resolveDeletionConflict(
				assumedMasterState,
				realMasterState,
				newDocumentState
			);

			if (deletionResolution) {
				return deletionResolution;
			}

			// A two-way live/live guess can destroy lifecycle meaning. The explicit sync path also defers
			// these rows; RxDB only performs a semantic merge when it can supply the true common base.
			return assumedMasterState
				? mergeWorkoutSessionConflict(newDocumentState, realMasterState, assumedMasterState)
				: realMasterState;
		}
	};

export const sessionExerciseConflictHandler: RxConflictHandler<
	SessionExercise & SyncedConflictRow
> = {
	isEqual: deepEqual,
	async resolve({ assumedMasterState, realMasterState, newDocumentState }) {
		const deletionResolution = resolveDeletionConflict(
			assumedMasterState,
			realMasterState,
			newDocumentState
		);

		if (deletionResolution) {
			return deletionResolution;
		}

		return assumedMasterState
			? mergeSessionExerciseConflict(newDocumentState, realMasterState, assumedMasterState)
			: realMasterState;
	}
};

export const sessionSetConflictHandler: RxConflictHandler<SessionSet & SyncedConflictRow> = {
	isEqual(first, second) {
		return deepEqual(first, second);
	},
	async resolve({ assumedMasterState, realMasterState, newDocumentState }) {
		const deletionResolution = resolveDeletionConflict(
			assumedMasterState,
			realMasterState,
			newDocumentState
		);

		if (deletionResolution) {
			return deletionResolution;
		}

		return mergeSessionSetConflict(newDocumentState, realMasterState, assumedMasterState);
	}
};
