import {
	addRxPlugin,
	createRxDatabase,
	type RxCollection,
	type RxDatabase,
	type RxDocumentData,
	type RxJsonSchema
} from 'rxdb';
import Dexie from 'dexie';
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema';
import {
	replicateSupabase,
	type RxSupabaseReplicationState
} from 'rxdb/plugins/replication-supabase';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { supabase } from './supabase';
import type {
	Exercise,
	ExerciseResetEvent,
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from './db';

type SyncedRow = {
	id: string;
	user_id: string;
};

export type SupabaseExercise = Exercise & SyncedRow;
export type SupabaseWorkout = Workout & SyncedRow;
export type SupabaseWorkoutExercise = WorkoutExercise & SyncedRow;
export type SupabaseWorkoutSession = WorkoutSession & SyncedRow;
export type SupabaseSessionExercise = SessionExercise & SyncedRow;
export type SupabaseSessionSet = SessionSet & SyncedRow;
export type SupabaseExerciseResetEvent = ExerciseResetEvent & SyncedRow;

export type TinyTrainRxCollections = {
	exercises: RxCollection<SupabaseExercise>;
	workouts: RxCollection<SupabaseWorkout>;
	workoutExercises: RxCollection<SupabaseWorkoutExercise>;
	workoutSessions: RxCollection<SupabaseWorkoutSession>;
	sessionExercises: RxCollection<SupabaseSessionExercise>;
	sessionSets: RxCollection<SupabaseSessionSet>;
	exerciseResetEvents: RxCollection<SupabaseExerciseResetEvent>;
};

export type TinyTrainRxDatabase = RxDatabase<TinyTrainRxCollections>;

type CollectionKey = keyof TinyTrainRxCollections;
type AwaitInSyncOptions = {
	timeoutMs?: number;
};

const collectionTableNames: Record<CollectionKey, string> = {
	exercises: 'exercises',
	workouts: 'workouts',
	workoutExercises: 'workout_exercises',
	workoutSessions: 'workout_sessions',
	sessionExercises: 'session_exercises',
	sessionSets: 'session_sets',
	exerciseResetEvents: 'exercise_reset_events'
};

const optionalFieldsByCollection: Record<CollectionKey, string[]> = {
	exercises: [],
	workouts: [],
	workoutExercises: [],
	workoutSessions: ['startedAt', 'completedAt'],
	sessionExercises: [],
	sessionSets: ['weightInput', 'repsInput', 'rirInput', 'weight', 'reps', 'rir'],
	exerciseResetEvents: []
};
const replicationBatchSize = 500;

const stringProperty = { type: 'string', maxLength: 500 } as const;
const timestampProperty = { type: 'string', format: 'date-time', maxLength: 80 } as const;
const booleanProperty = { type: 'boolean' } as const;
const numberProperty = { type: 'number' } as const;
const orderProperty = { type: 'number', multipleOf: 1, minimum: 0 } as const;

function createSchema<T>(schema: Omit<RxJsonSchema<T>, 'primaryKey' | 'type'>): RxJsonSchema<T> {
	return {
		...schema,
		primaryKey: 'id' as never,
		type: 'object',
		additionalProperties: false
	} as RxJsonSchema<T>;
}

// RxDB's schema generic needs the concrete document type per collection; the record has mixed schema types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schemas: Record<CollectionKey, RxJsonSchema<any>> = {
	exercises: createSchema<SupabaseExercise>({
		version: 0,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			name: stringProperty,
			normalizedName: stringProperty,
			unilateral: booleanProperty,
			source: { type: 'string', enum: ['baseline', 'custom'], maxLength: 20 },
			archived: booleanProperty,
			createdAt: timestampProperty,
			updatedAt: timestampProperty
		},
		required: [
			'id',
			'user_id',
			'name',
			'normalizedName',
			'unilateral',
			'source',
			'archived',
			'createdAt',
			'updatedAt'
		],
		indexes: ['user_id', 'normalizedName', ['user_id', 'normalizedName'], ['user_id', 'updatedAt']]
	}),
	workouts: createSchema<SupabaseWorkout>({
		version: 0,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			name: stringProperty,
			normalizedName: stringProperty,
			archived: booleanProperty,
			createdAt: timestampProperty,
			updatedAt: timestampProperty
		},
		required: ['id', 'user_id', 'name', 'normalizedName', 'archived', 'createdAt', 'updatedAt'],
		indexes: ['user_id', 'normalizedName', ['user_id', 'normalizedName']]
	}),
	workoutExercises: createSchema<SupabaseWorkoutExercise>({
		version: 0,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			workoutId: stringProperty,
			exerciseId: stringProperty,
			order: orderProperty,
			createdAt: timestampProperty,
			updatedAt: timestampProperty
		},
		required: ['id', 'user_id', 'workoutId', 'exerciseId', 'order', 'createdAt', 'updatedAt'],
		indexes: [
			'user_id',
			'workoutId',
			'exerciseId',
			['workoutId', 'order'],
			['workoutId', 'exerciseId']
		]
	}),
	workoutSessions: createSchema<SupabaseWorkoutSession>({
		version: 1,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			workoutId: stringProperty,
			workoutNameSnapshot: stringProperty,
			dayKey: stringProperty,
			startedAt: timestampProperty,
			completedAt: timestampProperty,
			status: {
				type: 'string',
				enum: ['planned', 'in_progress', 'completed', 'abandoned'],
				maxLength: 20
			},
			createdAt: timestampProperty,
			updatedAt: timestampProperty
		},
		required: [
			'id',
			'user_id',
			'workoutId',
			'workoutNameSnapshot',
			'dayKey',
			'status',
			'createdAt',
			'updatedAt'
		],
		indexes: ['user_id', 'workoutId', 'dayKey', 'status']
	}),
	sessionExercises: createSchema<SupabaseSessionExercise>({
		version: 0,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			sessionId: stringProperty,
			workoutId: stringProperty,
			exerciseId: stringProperty,
			exerciseNameSnapshot: stringProperty,
			order: orderProperty,
			performedAt: timestampProperty,
			createdAt: timestampProperty,
			updatedAt: timestampProperty
		},
		required: [
			'id',
			'user_id',
			'sessionId',
			'workoutId',
			'exerciseId',
			'exerciseNameSnapshot',
			'order',
			'performedAt',
			'createdAt',
			'updatedAt'
		],
		indexes: [
			'user_id',
			'sessionId',
			'workoutId',
			'exerciseId',
			['sessionId', 'order'],
			['exerciseId', 'performedAt']
		]
	}),
	sessionSets: createSchema<SupabaseSessionSet>({
		version: 0,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			sessionExerciseId: stringProperty,
			exerciseId: stringProperty,
			order: orderProperty,
			side: { type: 'string', enum: ['bilateral', 'left', 'right'], maxLength: 20 },
			weightInput: stringProperty,
			repsInput: stringProperty,
			rirInput: stringProperty,
			weight: numberProperty,
			reps: numberProperty,
			rir: numberProperty,
			createdAt: timestampProperty,
			updatedAt: timestampProperty
		},
		required: [
			'id',
			'user_id',
			'sessionExerciseId',
			'exerciseId',
			'order',
			'side',
			'createdAt',
			'updatedAt'
		],
		indexes: [
			'user_id',
			'sessionExerciseId',
			'exerciseId',
			['sessionExerciseId', 'order'],
			['exerciseId', 'createdAt']
		]
	}),
	exerciseResetEvents: createSchema<SupabaseExerciseResetEvent>({
		version: 0,
		properties: {
			id: stringProperty,
			user_id: stringProperty,
			exerciseId: stringProperty,
			resetAt: timestampProperty,
			createdAt: timestampProperty
		},
		required: ['id', 'user_id', 'exerciseId', 'resetAt', 'createdAt'],
		indexes: ['user_id', 'exerciseId', 'resetAt', ['exerciseId', 'resetAt']]
	})
};

const databaseByUserId = new Map<string, Promise<TinyTrainRxDatabase>>();
const replicationByUserId = new Map<string, RxSupabaseReplicationState<SyncedRow>[]>();
let pluginsRegistered = false;

function registerRxdbPlugins() {
	if (pluginsRegistered) {
		return;
	}

	pluginsRegistered = true;
	addRxPlugin(RxDBMigrationSchemaPlugin);
}

function toDatabaseName(userId: string) {
	return `tinytrain_supabase_${userId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function removeNullOptionalValues<T extends Record<string, unknown>>(
	collectionName: CollectionKey,
	doc: T
) {
	for (const key of optionalFieldsByCollection[collectionName]) {
		if (doc[key] === null) {
			delete doc[key];
		}
	}

	return doc;
}

function toOptionalNumber(value: unknown) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim()) {
		const nextValue = Number(value);
		return Number.isFinite(nextValue) ? nextValue : undefined;
	}

	return undefined;
}

function normalizePulledDoc<T extends Record<string, unknown>>(
	collectionName: CollectionKey,
	doc: T
) {
	const nextDoc = removeNullOptionalValues(collectionName, doc) as Record<string, unknown>;

	if (collectionName === 'sessionSets') {
		for (const key of ['weight', 'reps', 'rir']) {
			const nextValue = toOptionalNumber(nextDoc[key]);

			if (nextValue === undefined) {
				delete nextDoc[key];
			} else {
				nextDoc[key] = nextValue;
			}
		}
	}

	return nextDoc as T;
}

export function toSupabaseRowId(userId: string, localId: string) {
	return localId.startsWith(`${userId}:`) ? localId : `${userId}:${localId}`;
}

export function fromSupabaseRowId(userId: string, remoteId: string) {
	return remoteId.startsWith(`${userId}:`) ? remoteId.slice(userId.length + 1) : remoteId;
}

export function addUserId<T extends { id: string }>(
	userId: string,
	doc: T
): T & { user_id: string } {
	return {
		...doc,
		id: toSupabaseRowId(userId, doc.id),
		user_id: userId
	};
}

export async function getTinyTrainRxDatabase(userId: string): Promise<TinyTrainRxDatabase> {
	const existing = databaseByUserId.get(userId);

	if (existing) {
		return existing;
	}

	registerRxdbPlugins();

	const next = createRxDatabase<TinyTrainRxCollections>({
		name: toDatabaseName(userId),
		storage: getRxStorageDexie(),
		multiInstance: true,
		eventReduce: true
	}).then(async (database) => {
		await database.addCollections({
			exercises: { schema: schemas.exercises },
			workouts: { schema: schemas.workouts },
			workoutExercises: { schema: schemas.workoutExercises },
			workoutSessions: {
				schema: schemas.workoutSessions,
				migrationStrategies: {
					1: (oldDoc: RxDocumentData<SupabaseWorkoutSession>) => oldDoc
				}
			},
			sessionExercises: { schema: schemas.sessionExercises },
			sessionSets: { schema: schemas.sessionSets },
			exerciseResetEvents: { schema: schemas.exerciseResetEvents }
		});

		return database;
	});

	databaseByUserId.set(userId, next);
	return next;
}

export async function resetTinyTrainRxDatabase(userId: string) {
	const existing = databaseByUserId.get(userId);
	const replications = replicationByUserId.get(userId);

	for (const replication of replications ?? []) {
		replication.cancel();
	}

	replicationByUserId.delete(userId);
	databaseByUserId.delete(userId);

	if (existing) {
		const database = await existing.catch(() => null);
		await database?.close();
	}

	const databaseName = toDatabaseName(userId);
	const knownCollections = [
		'_rxdb_internal',
		'exercises',
		'workouts',
		'workoutExercises',
		'workoutSessions',
		'sessionExercises',
		'sessionSets',
		'exerciseResetEvents'
	];
	const knownVersions = [0, 1];
	const knownDatabaseNames = knownCollections.flatMap((collectionName) =>
		knownVersions.map((version) => `rxdb-dexie-${databaseName}--${version}--${collectionName}`)
	);
	const availableDatabaseNames =
		typeof indexedDB !== 'undefined' && 'databases' in indexedDB
			? (await indexedDB.databases())
					.map((database) => database.name)
					.filter((name): name is string =>
						Boolean(name?.startsWith(`rxdb-dexie-${databaseName}--`))
					)
			: [];
	const namesToDelete = [...new Set([...knownDatabaseNames, ...availableDatabaseNames])];

	await Promise.all(namesToDelete.map((name) => Dexie.delete(name).catch(() => undefined)));
}

export async function startSupabaseReplication(userId: string) {
	const existing = replicationByUserId.get(userId);

	if (existing) {
		return existing;
	}

	const database = await getTinyTrainRxDatabase(userId);
	const replications = (Object.keys(collectionTableNames) as CollectionKey[]).map(
		(collectionName) =>
			replicateSupabase({
				tableName: collectionTableNames[collectionName],
				client: supabase,
				collection: database[collectionName] as unknown as RxCollection<SyncedRow>,
				replicationIdentifier: `${userId}:${collectionTableNames[collectionName]}`,
				live: true,
				waitForLeadership: false,
				pull: {
					batchSize: replicationBatchSize,
					queryBuilder: ({ query }) => query.eq('user_id', userId),
					modifier: (doc) =>
						normalizePulledDoc(collectionName, doc as Record<string, unknown>) as SyncedRow & {
							_deleted: boolean;
						}
				},
				push: {
					batchSize: replicationBatchSize
				}
			})
	);

	for (const replication of replications) {
		replication.error$.subscribe((error) => {
			console.error('[supabase replication]', error);
		});
	}

	replicationByUserId.set(userId, replications);
	return replications;
}

export async function awaitSupabaseInitialReplication(userId: string) {
	const replications = await startSupabaseReplication(userId);
	await Promise.all(replications.map((replication) => replication.awaitInitialReplication()));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	});
}

export async function awaitSupabaseInSync(userId: string, options: AwaitInSyncOptions = {}) {
	const replications = await startSupabaseReplication(userId);
	for (const replication of replications) {
		replication.reSync();
	}

	const syncPromise = Promise.all(replications.map((replication) => replication.awaitInSync()));

	if (options.timeoutMs) {
		await withTimeout(
			syncPromise,
			options.timeoutMs,
			'Cloud sync is still running. Try again in a moment.'
		);
		return;
	}

	await syncPromise;
}
