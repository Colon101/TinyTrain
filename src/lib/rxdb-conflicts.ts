import type { RxConflictHandler } from 'rxdb';
import { deepEqual } from 'rxdb/plugins/utils';
import type { SessionSet } from './db/models';
import { chooseSessionSetConflict } from './db/session-set-conflict';

export const sessionSetConflictHandler: RxConflictHandler<SessionSet & { user_id: string }> = {
	isEqual(first, second) {
		return deepEqual(first, second);
	},
	async resolve({ realMasterState, newDocumentState }) {
		if (realMasterState._deleted !== newDocumentState._deleted) {
			return realMasterState;
		}

		return chooseSessionSetConflict(newDocumentState, realMasterState).row;
	}
};
