import Dexie from 'dexie';
import dexieCloud, { type DexieCloudTable } from 'dexie-cloud-addon';
import { BASELINE_EXERCISES } from './exercises';

export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';
export type ExerciseSource = 'baseline' | 'custom';
export type SessionSetSide = 'bilateral' | 'left' | 'right';
export type SessionInputField = 'weight' | 'reps' | 'rir';

export interface Exercise {
	id: string;
	name: string;
	normalizedName: string;
	unilateral: boolean;
	source: ExerciseSource;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Workout {
	id: string;
	name: string;
	normalizedName: string;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutExercise {
	id: string;
	workoutId: string;
	exerciseId: string;
	order: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutSession {
	id: string;
	workoutId: string;
	workoutNameSnapshot: string;
	dayKey: string;
	startedAt?: string;
	completedAt?: string;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
}

export interface SessionExercise {
	id: string;
	sessionId: string;
	workoutId: string;
	exerciseId: string;
	exerciseNameSnapshot: string;
	order: number;
	performedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionSet {
	id: string;
	sessionExerciseId: string;
	exerciseId: string;
	order: number;
	side: SessionSetSide;
	weightInput?: string;
	repsInput?: string;
	rirInput?: string;
	weight?: number;
	reps?: number;
	rir?: number;
	createdAt: string;
	updatedAt: string;
}

export interface ExerciseResetEvent {
	id: string;
	exerciseId: string;
	resetAt: string;
	createdAt: string;
}

export type WorkoutExerciseWithExercise = WorkoutExercise & {
	exercise: Exercise;
};

export type SessionSummary = WorkoutSession & {
	totalExercises: number;
	totalSets: number;
};

export type DayOverview = {
	dayKey: string;
	session: SessionSummary | null;
};

export type ExerciseListItem = {
	exercise: Exercise;
	historyCount: number;
	lastPerformedAt?: string;
	latestResetAt?: string;
};

export type ExerciseHistoryEntry = {
	sessionId: string;
	workoutId: string;
	workoutNameSnapshot: string;
	dayKey: string;
	performedAt?: string;
	startedAt?: string;
	completedAt?: string;
	status: SessionStatus;
	sets: SessionSet[];
};

export type SessionExerciseDetail = SessionExercise & {
	sets: SessionSet[];
};

export type SessionFieldDeltaState = 'improved' | 'regressed' | 'matched' | 'empty';

export type SessionFieldDelta = {
	state: SessionFieldDeltaState;
	label: string;
};

export type SessionSetReference = {
	sessionId: string;
	startedAt?: string;
	completedAt?: string;
	order: number;
	side: SessionSetSide;
	weight?: number;
	reps?: number;
	rir?: number;
};

export type SessionSetOverview = SessionSet & {
	label: string;
	previousReference: SessionSetReference | null;
	weightDelta: SessionFieldDelta;
	repsDelta: SessionFieldDelta;
	rirDelta: SessionFieldDelta;
};

export type SessionExerciseProgressStatus = 'new' | 'matched' | 'improved' | 'regressed' | 'mixed';

export type SessionExerciseOverview = SessionExerciseDetail & {
	exercise: Exercise | null;
	previousPerformance: ExerciseHistoryEntry | null;
	progressStatus: SessionExerciseProgressStatus;
	progressSummary: string;
	sets: SessionSetOverview[];
};

export type SessionProgressSummary = {
	improvedExercises: number;
	matchedExercises: number;
	regressedExercises: number;
	mixedExercises: number;
	newExercises: number;
};

export type SessionOverview = {
	summary: SessionSummary;
	previousSummary: SessionSummary | null;
	progress: SessionProgressSummary | null;
	exercises: SessionExerciseOverview[];
};

export type ExerciseDetail = {
	exercise: Exercise;
	history: ExerciseHistoryEntry[];
	resetEvents: ExerciseResetEvent[];
};

export type BackfillSeedResult = {
	workoutId: string;
	sessionId: string;
	created: boolean;
};

export type BackfillSessionSetInput = {
	order?: number;
	side?: SessionSetSide;
	weightInput?: string;
	repsInput?: string;
	rirInput?: string;
};

export type BackfillSessionExerciseInput = {
	exerciseId: string;
	sets: BackfillSessionSetInput[];
};

export type BackfillWorkoutSessionInput = {
	workoutId: string;
	dayKey: string;
	startTime: string;
	durationMinutes: number;
	exercises: BackfillSessionExerciseInput[];
};

type HistoricalSessionExerciseMatch = {
	session: WorkoutSession;
	sessionExercise: SessionExercise;
	sets: SessionSet[];
};

const STORES = {
	exercises: '&id, &normalizedName, source, archived, updatedAt',
	workouts: '&id, &normalizedName, archived, updatedAt',
	workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
	workoutSessions:
		'&id, workoutId, dayKey, startedAt, completedAt, status, [workoutId+startedAt], [dayKey+startedAt]',
	sessionExercises:
		'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
	sessionSets:
		'&id, sessionExerciseId, exerciseId, createdAt, side, [sessionExerciseId+order], [sessionExerciseId+order+side], [exerciseId+createdAt]',
	exerciseResetEvents: '&id, exerciseId, resetAt, [exerciseId+resetAt], createdAt'
};

const SYNC_SAFE_STORES = {
	...STORES,
	exercises: '&id, normalizedName, source, archived, updatedAt'
};

const EXAMPLE_WORKOUT_NAME = 'Upper Builder Demo';
const EXAMPLE_EXERCISE_NAMES = ['Barbell Bench Press', 'Wide Grip Pull-up', 'Cable Lateral Raise'];
const BASELINE_EXERCISE_BY_NAME = new Map(
	BASELINE_EXERCISES.map((exercise) => [normalizeName(exercise.name), exercise])
);

class TinyTrainDatabase extends Dexie {
	exercises!: DexieCloudTable<Exercise, 'id'>;
	workouts!: DexieCloudTable<Workout, 'id'>;
	workoutExercises!: DexieCloudTable<WorkoutExercise, 'id'>;
	workoutSessions!: DexieCloudTable<WorkoutSession, 'id'>;
	sessionExercises!: DexieCloudTable<SessionExercise, 'id'>;
	sessionSets!: DexieCloudTable<SessionSet, 'id'>;
	exerciseResetEvents!: DexieCloudTable<ExerciseResetEvent, 'id'>;

	constructor() {
		super('tinytrain', { addons: [dexieCloud] });

		this.version(1).stores({
			exercises: '&id, &normalizedName, archived, updatedAt',
			workouts: '&id, &normalizedName, archived, updatedAt',
			workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
			workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
			sessionExercises:
				'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
			sessionSets:
				'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
		});
		this.version(2)
			.stores({
				exercises: '&id, &normalizedName, archived, updatedAt',
				workouts: '&id, &normalizedName, archived, updatedAt',
				workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
				workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
				sessionExercises:
					'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
				sessionSets:
					'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
			})
			.upgrade((transaction) => {
				return transaction
					.table('exercises')
					.toCollection()
					.modify((exercise: Partial<Exercise>) => {
						exercise.unilateral = Boolean(exercise.unilateral);
					});
			});
		this.version(3).stores({
			exercises: '&id, &normalizedName, archived, updatedAt',
			workouts: '&id, &normalizedName, archived, updatedAt',
			workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
			workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
			sessionExercises:
				'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
			sessionSets:
				'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
		});
		this.version(4)
			.stores(STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('exercises')
					.toCollection()
					.modify((exercise: Partial<Exercise> & { name?: string; normalizedName?: string }) => {
						exercise.unilateral = Boolean(exercise.unilateral);
						exercise.normalizedName = normalizeName(exercise.name ?? exercise.normalizedName ?? '');
						exercise.source = inferExerciseSource(
							exercise.normalizedName || exercise.name || '',
							exercise.source
						);
					});

				await transaction
					.table('workoutSessions')
					.toCollection()
					.modify((session: Partial<WorkoutSession>) => {
						session.dayKey = toDayKey(session.startedAt ?? session.createdAt ?? new Date());
					});
			});
		this.version(5)
			.stores(STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('sessionSets')
					.toCollection()
					.modify(
						(
							sessionSet: Partial<SessionSet> & {
								weight?: unknown;
								reps?: unknown;
								rir?: unknown;
							}
						) => {
							const weight = toOptionalNumber(sessionSet.weight);
							const reps = toOptionalNumber(sessionSet.reps);
							const rir = toOptionalNumber(sessionSet.rir);

							if (weight === undefined) {
								delete sessionSet.weight;
							} else {
								sessionSet.weight = weight;
							}

							if (reps === undefined) {
								delete sessionSet.reps;
							} else {
								sessionSet.reps = reps;
							}

							if (rir === undefined) {
								delete sessionSet.rir;
							} else {
								sessionSet.rir = rir;
							}
						}
					);
			});
		this.version(6)
			.stores(SYNC_SAFE_STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('exercises')
					.toCollection()
					.modify((exercise: Partial<Exercise> & { name?: string; normalizedName?: string }) => {
						exercise.normalizedName = normalizeName(exercise.name ?? exercise.normalizedName ?? '');
						exercise.source = inferExerciseSource(
							exercise.normalizedName || exercise.name || '',
							exercise.source
						);
					});
			});
		this.version(7)
			.stores(SYNC_SAFE_STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('workoutSessions')
					.toCollection()
					.modify((session: Partial<WorkoutSession>) => {
						if (!session.dayKey) {
							session.dayKey = toDayKey(session.startedAt ?? session.createdAt ?? new Date());
						}

						if (!session.startedAt) {
							delete session.startedAt;
						}
					});

				await transaction
					.table('sessionSets')
					.toCollection()
					.modify((sessionSet: Partial<SessionSet>) => {
						sessionSet.side = normalizeSessionSetSide(sessionSet.side);
						sessionSet.weight = toOptionalNumber(sessionSet.weight);
						sessionSet.reps = toOptionalNumber(sessionSet.reps);
						sessionSet.rir = toOptionalNumber(sessionSet.rir);
						sessionSet.weightInput = toStoredInputValue(
							typeof sessionSet.weightInput === 'string' ? sessionSet.weightInput : undefined,
							sessionSet.weight
						);
						sessionSet.repsInput = toStoredInputValue(
							typeof sessionSet.repsInput === 'string' ? sessionSet.repsInput : undefined,
							sessionSet.reps
						);
						sessionSet.rirInput = toStoredInputValue(
							typeof sessionSet.rirInput === 'string' ? sessionSet.rirInput : undefined,
							sessionSet.rir
						);
					});
			});

		this.cloud.configure({
			databaseUrl: 'https://zpai2umlq.dexie.cloud',
			nameSuffix: false,
			tryUseServiceWorker: false,
			disableEagerSync: true,
			disableWebSocket: true
		});
	}
}

export const db = new TinyTrainDatabase();
let dbOpenPromise: Promise<TinyTrainDatabase> | null = null;

export type PersistentStorageStatus = 'persisted' | 'promptable' | 'denied' | 'unsupported';

export async function getPersistentStorageStatus(): Promise<PersistentStorageStatus> {
	if (!globalThis.navigator?.storage?.persisted) {
		return 'unsupported';
	}

	return (await navigator.storage.persisted()) ? 'persisted' : 'promptable';
}

export async function requestPersistentStorage(): Promise<PersistentStorageStatus> {
	if (!globalThis.navigator?.storage?.persisted || !globalThis.navigator.storage.persist) {
		return 'unsupported';
	}

	if (await navigator.storage.persisted()) {
		return 'persisted';
	}

	return (await navigator.storage.persist()) ? 'persisted' : 'denied';
}

export async function loginWithGoogle(redirectPath = '/') {
	await db.cloud.login({ provider: 'google', redirectPath });
}

export async function ensureDbOpen() {
	if (!dbOpenPromise) {
		dbOpenPromise = db
			.open()
			.then(() => db)
			.catch((error) => {
				dbOpenPromise = null;
				throw error;
			});
	}

	return dbOpenPromise;
}

export async function logoutFromCloud() {
	await ensureDbOpen();
	await db.cloud.logout();
}

export async function syncNow() {
	await ensureDbOpen();
	await db.cloud.sync();
}

function canAttemptCloudSync() {
	return Boolean(
		db.cloud.currentUser.value?.isLoggedIn && (typeof navigator === 'undefined' || navigator.onLine)
	);
}

async function syncCloudAtSessionBoundary() {
	if (!canAttemptCloudSync()) {
		return;
	}

	try {
		await db.cloud.sync({ wait: true, purpose: 'push' });
	} catch (error) {
		console.warn('Session boundary sync failed; changes remain queued locally.', error);
	}
}

export function toDayKey(input: Date | string) {
	const date = toValidDate(input);

	return [
		String(date.getFullYear()).padStart(4, '0'),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0')
	].join('-');
}

function toValidDate(input: Date | string) {
	const date = input instanceof Date ? new Date(input) : new Date(input);

	if (Number.isNaN(date.getTime())) {
		return new Date();
	}

	return date;
}

function requireLoggedInUser() {
	if (!db.cloud.currentUser.value?.isLoggedIn) {
		throw new Error('Sign in with Google to save workouts.');
	}
}

function timestamp(date = new Date()) {
	return date.toISOString();
}

function isDefined<T>(value: T): value is NonNullable<T> {
	return value !== undefined && value !== null;
}

function createId() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeName(name: string) {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function displayName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

function inferExerciseSource(nameOrNormalizedName: string, source?: ExerciseSource) {
	if (source) {
		return source;
	}

	return BASELINE_EXERCISE_BY_NAME.has(normalizeName(nameOrNormalizedName)) ? 'baseline' : 'custom';
}

function withExerciseDefaults(exercise: Exercise): Exercise {
	return {
		...exercise,
		unilateral: Boolean(exercise.unilateral),
		source: inferExerciseSource(exercise.normalizedName || exercise.name, exercise.source)
	};
}

function compareExercises(first: Exercise, second: Exercise) {
	if (first.archived !== second.archived) {
		return Number(first.archived) - Number(second.archived);
	}

	if (first.source !== second.source) {
		return first.source === 'baseline' ? -1 : 1;
	}

	if (first.updatedAt !== second.updatedAt) {
		return second.updatedAt.localeCompare(first.updatedAt);
	}

	if (first.createdAt !== second.createdAt) {
		return first.createdAt.localeCompare(second.createdAt);
	}

	return first.id.localeCompare(second.id);
}

function pickPreferredExercise(exercises: Exercise[]) {
	return exercises.map(withExerciseDefaults).sort(compareExercises)[0] ?? null;
}

function dedupeExercises(exercises: Exercise[]) {
	const exerciseByNormalizedName = new Map<string, Exercise>();

	for (const exercise of exercises.map(withExerciseDefaults)) {
		const existingExercise = exerciseByNormalizedName.get(exercise.normalizedName);

		if (!existingExercise || compareExercises(exercise, existingExercise) < 0) {
			exerciseByNormalizedName.set(exercise.normalizedName, exercise);
		}
	}

	return [...exerciseByNormalizedName.values()];
}

function toOptionalNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toStoredInputValue(rawValue?: string, numericValue?: number) {
	if (typeof rawValue === 'string') {
		return rawValue;
	}

	return typeof numericValue === 'number' && Number.isFinite(numericValue) ? `${numericValue}` : '';
}

function toParsedInputValue(rawValue: string, field?: SessionInputField) {
	if (!rawValue.trim()) {
		return undefined;
	}

	const cleanValue = toCleanSessionInputValue(rawValue, field);

	if (!cleanValue) {
		return undefined;
	}

	const nextValue = Number(cleanValue);

	return Number.isFinite(nextValue) ? nextValue : undefined;
}

function toCleanSessionInputValue(rawValue: string, field?: SessionInputField) {
	return field === 'reps' || field === 'rir' ? rawValue.trim().replace(/\D/g, '') : rawValue.trim();
}

function normalizeSessionSetSide(side: unknown): SessionSetSide {
	return side === 'left' || side === 'right' || side === 'bilateral' ? side : 'bilateral';
}

function hasInputValue(value?: string) {
	return typeof value === 'string' && value.trim().length > 0;
}

function hasAnySetValue(
	sessionSet: Pick<SessionSet, 'weight' | 'reps' | 'rir' | 'weightInput' | 'repsInput' | 'rirInput'>
) {
	return (
		hasInputValue(sessionSet.weightInput) ||
		hasInputValue(sessionSet.repsInput) ||
		hasInputValue(sessionSet.rirInput) ||
		(typeof sessionSet.weight === 'number' && Number.isFinite(sessionSet.weight)) ||
		(typeof sessionSet.reps === 'number' && Number.isFinite(sessionSet.reps)) ||
		(typeof sessionSet.rir === 'number' && Number.isFinite(sessionSet.rir))
	);
}

function getSessionSortTime(session: Pick<WorkoutSession, 'startedAt' | 'createdAt'>) {
	return toValidDate(session.startedAt ?? session.createdAt).getTime();
}

function getExerciseHistorySortTime(
	entry: Pick<ExerciseHistoryEntry, 'performedAt' | 'startedAt' | 'completedAt' | 'dayKey'>
) {
	return toValidDate(
		entry.performedAt ?? entry.startedAt ?? entry.completedAt ?? `${entry.dayKey}T12:00:00`
	).getTime();
}

function compareSessionRows(
	first: Pick<WorkoutSession, 'id' | 'startedAt' | 'createdAt'>,
	second: Pick<WorkoutSession, 'id' | 'startedAt' | 'createdAt'>
) {
	return (
		getSessionSortTime(first) - getSessionSortTime(second) || first.id.localeCompare(second.id)
	);
}

function getSessionExerciseSortTime(
	sessionExercise: Pick<SessionExercise, 'performedAt'>,
	session: Pick<WorkoutSession, 'startedAt' | 'createdAt'>
) {
	return toValidDate(
		sessionExercise.performedAt || session.startedAt || session.createdAt
	).getTime();
}

function compareHistoricalSessionExerciseMatches(
	first: HistoricalSessionExerciseMatch,
	second: HistoricalSessionExerciseMatch
) {
	return (
		getSessionExerciseSortTime(first.sessionExercise, first.session) -
			getSessionExerciseSortTime(second.sessionExercise, second.session) ||
		first.sessionExercise.id.localeCompare(second.sessionExercise.id)
	);
}

async function listEquivalentExerciseIds(exerciseId: string) {
	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		return [exerciseId];
	}

	const normalizedName = normalizeName(exercise.normalizedName || exercise.name);

	if (!normalizedName) {
		return [exerciseId];
	}

	const matchingExercises = await db.exercises
		.where('normalizedName')
		.equals(normalizedName)
		.toArray();

	return [
		...new Set([exerciseId, ...matchingExercises.map((matchingExercise) => matchingExercise.id)])
	];
}

async function listHistoricalSessionExerciseMatches(
	exerciseId: string
): Promise<HistoricalSessionExerciseMatch[]> {
	const exercise = await db.exercises.get(exerciseId);
	const equivalentExerciseIds = await listEquivalentExerciseIds(exerciseId);
	const normalizedName = exercise ? normalizeName(exercise.normalizedName || exercise.name) : '';
	const [idMatchedSessionExercises, nameMatchedSessionExercises] = await Promise.all([
		equivalentExerciseIds.length === 0
			? Promise.resolve([])
			: equivalentExerciseIds.length === 1
				? db.sessionExercises.where('exerciseId').equals(equivalentExerciseIds[0]).toArray()
				: db.sessionExercises.where('exerciseId').anyOf(equivalentExerciseIds).toArray(),
		normalizedName
			? db.sessionExercises
					.toArray()
					.then((rows) =>
						rows.filter(
							(sessionExercise) =>
								normalizeName(sessionExercise.exerciseNameSnapshot) === normalizedName
						)
					)
			: Promise.resolve([])
	]);
	const sessionExercises = [
		...new Map(
			[...idMatchedSessionExercises, ...nameMatchedSessionExercises].map((sessionExercise) => [
				sessionExercise.id,
				sessionExercise
			])
		).values()
	];

	if (sessionExercises.length === 0) {
		return [];
	}

	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const [sessions, sessionSets] = await Promise.all([
		db.workoutSessions.bulkGet(sessionIds),
		db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExercises.map((sessionExercise) => sessionExercise.id))
			.toArray()
			.then((rows) => rows.map(withSessionSetDefaults))
	]);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises
		.flatMap((sessionExercise) => {
			const session = sessionById.get(sessionExercise.sessionId);

			if (!session || session.status === 'planned') {
				return [];
			}

			return [
				{
					session,
					sessionExercise,
					sets: (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(compareSessionSetRows)
				}
			];
		})
		.sort((first, second) => compareHistoricalSessionExerciseMatches(second, first));
}

async function getPreferredExerciseByNormalizedNames(normalizedNames: string[]) {
	const uniqueNormalizedNames = [...new Set(normalizedNames.filter(Boolean))];

	if (uniqueNormalizedNames.length === 0) {
		return new Map<string, Exercise>();
	}

	const matchingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(uniqueNormalizedNames)
		.toArray();
	const exercisesByNormalizedName = new Map<string, Exercise[]>();

	for (const exercise of matchingExercises) {
		const rows = exercisesByNormalizedName.get(exercise.normalizedName) ?? [];
		rows.push(exercise);
		exercisesByNormalizedName.set(exercise.normalizedName, rows);
	}

	return new Map(
		uniqueNormalizedNames.flatMap((normalizedName) => {
			const preferredExercise = pickPreferredExercise(
				exercisesByNormalizedName.get(normalizedName) ?? []
			);

			return preferredExercise ? ([[normalizedName, preferredExercise]] as const) : [];
		})
	);
}

function getSessionSetSideOrder(side: SessionSetSide) {
	switch (side) {
		case 'right':
			return 1;
		case 'left':
			return 2;
		default:
			return 0;
	}
}

function compareSessionSetRows(
	first: Pick<SessionSet, 'id' | 'order' | 'side'>,
	second: Pick<SessionSet, 'id' | 'order' | 'side'>
) {
	if (first.order !== second.order) {
		return first.order - second.order;
	}

	return (
		getSessionSetSideOrder(normalizeSessionSetSide(first.side)) -
			getSessionSetSideOrder(normalizeSessionSetSide(second.side)) ||
		first.id.localeCompare(second.id)
	);
}

function getSessionSetLabel(sessionSet: Pick<SessionSet, 'order' | 'side'>) {
	const side = normalizeSessionSetSide(sessionSet.side);

	if (side === 'bilateral') {
		return `Set ${String(sessionSet.order).padStart(2, '0')}`;
	}

	return `${side === 'right' ? 'R' : 'L'}${sessionSet.order}`;
}

function getSessionSetKey(sessionSet: Pick<SessionSet, 'order' | 'side'>) {
	return `${sessionSet.order}:${normalizeSessionSetSide(sessionSet.side)}`;
}

function withSessionSetDefaults(sessionSet: SessionSet): SessionSet {
	return {
		...sessionSet,
		side: normalizeSessionSetSide(sessionSet.side),
		weightInput: toStoredInputValue(sessionSet.weightInput, toOptionalNumber(sessionSet.weight)),
		repsInput: toStoredInputValue(sessionSet.repsInput, toOptionalNumber(sessionSet.reps)),
		rirInput: toStoredInputValue(sessionSet.rirInput, toOptionalNumber(sessionSet.rir)),
		weight: toOptionalNumber(sessionSet.weight),
		reps: toOptionalNumber(sessionSet.reps),
		rir: toOptionalNumber(sessionSet.rir)
	};
}

async function listSessionExerciseDetails(sessionId: string): Promise<SessionExerciseDetail[]> {
	const sessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.sortBy('order');
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()).map(
					withSessionSetDefaults
				);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises.map((sessionExercise) => ({
		...sessionExercise,
		sets: (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(compareSessionSetRows)
	}));
}

function formatSignedDelta(diff: number) {
	return `${diff > 0 ? '+' : ''}${Number(diff.toFixed(2))}`;
}

function createFieldDelta(current?: number, previous?: number): SessionFieldDelta {
	if (
		typeof current !== 'number' ||
		!Number.isFinite(current) ||
		typeof previous !== 'number' ||
		!Number.isFinite(previous)
	) {
		return {
			state: 'empty',
			label: ''
		};
	}

	const diff = Number((current - previous).toFixed(2));

	if (diff > 0) {
		return {
			state: 'improved',
			label: formatSignedDelta(diff)
		};
	}

	if (diff < 0) {
		return {
			state: 'regressed',
			label: formatSignedDelta(diff)
		};
	}

	return {
		state: 'matched',
		label: ''
	};
}

function toSessionSetReference(
	entry: ExerciseHistoryEntry,
	sessionSet: SessionSet
): SessionSetReference {
	return {
		sessionId: entry.sessionId,
		startedAt: entry.startedAt,
		completedAt: entry.completedAt,
		order: sessionSet.order,
		side: sessionSet.side,
		weight: sessionSet.weight,
		reps: sessionSet.reps,
		rir: sessionSet.rir
	};
}

function buildPreviousReferenceBySetKey(
	currentExercise: SessionExerciseDetail,
	history: ExerciseHistoryEntry[]
) {
	const referenceBySetKey = new Map<string, SessionSetReference>();

	for (const currentSet of currentExercise.sets) {
		const setKey = getSessionSetKey(currentSet);

		if (referenceBySetKey.has(setKey)) {
			continue;
		}

		for (const historyEntry of history) {
			const previousSet = historyEntry.sets.find(
				(candidate) => getSessionSetKey(candidate) === setKey && hasAnySetValue(candidate)
			);

			if (!previousSet) {
				continue;
			}

			referenceBySetKey.set(setKey, toSessionSetReference(historyEntry, previousSet));
			break;
		}
	}

	return referenceBySetKey;
}

function getSessionSetOrderCount(sessionSets: Array<Pick<SessionSet, 'order'>>) {
	return sessionSets.reduce((highestOrder, sessionSet) => {
		return Math.max(highestOrder, sessionSet.order);
	}, 0);
}

function findLatestHistoryEntryWithSeedRows(history: ExerciseHistoryEntry[]) {
	return history.find((entry) => getSessionSetOrderCount(entry.sets) > 0) ?? null;
}

function summarizeExerciseProgress(
	currentExercise: SessionExerciseDetail,
	previousReferenceBySetKey: Map<string, SessionSetReference>
) {
	if (previousReferenceBySetKey.size === 0) {
		return {
			progressStatus: 'new' as const,
			progressSummary: 'First logged performance for this exercise.'
		};
	}

	let improvedFieldCount = 0;
	let regressedFieldCount = 0;

	for (const currentSet of currentExercise.sets) {
		const previousReference = previousReferenceBySetKey.get(getSessionSetKey(currentSet));

		if (!previousReference) {
			continue;
		}

		for (const fieldDelta of [
			createFieldDelta(currentSet.weight, previousReference.weight),
			createFieldDelta(currentSet.reps, previousReference.reps),
			createFieldDelta(currentSet.rir, previousReference.rir)
		]) {
			if (fieldDelta.state === 'improved') {
				improvedFieldCount += 1;
				continue;
			}

			if (fieldDelta.state === 'regressed') {
				regressedFieldCount += 1;
			}
		}
	}

	const summaryParts: string[] = [];

	if (improvedFieldCount > 0) {
		summaryParts.push(`${improvedFieldCount} higher field${improvedFieldCount === 1 ? '' : 's'}`);
	}

	if (regressedFieldCount > 0) {
		summaryParts.push(`${regressedFieldCount} lower field${regressedFieldCount === 1 ? '' : 's'}`);
	}

	if (summaryParts.length === 0) {
		return {
			progressStatus: 'matched' as const,
			progressSummary: 'Matched the last workout.'
		};
	}

	if (improvedFieldCount > 0 && regressedFieldCount === 0) {
		return {
			progressStatus: 'improved' as const,
			progressSummary: summaryParts.join(', ')
		};
	}

	if (regressedFieldCount > 0 && improvedFieldCount === 0) {
		return {
			progressStatus: 'regressed' as const,
			progressSummary: summaryParts.join(', ')
		};
	}

	return {
		progressStatus: 'mixed' as const,
		progressSummary: summaryParts.join(', ')
	};
}

async function getLatestExerciseHistoryEntries(
	exerciseIds: string[],
	currentSessionId: string,
	beforeSessionAt: number
) {
	const uniqueExerciseIds = [...new Set(exerciseIds)];
	const previousEntries = await Promise.all(
		uniqueExerciseIds.map(async (exerciseId) => {
			const history = (await listExerciseHistory(exerciseId)).filter(
				(entry) =>
					entry.sessionId !== currentSessionId &&
					getExerciseHistorySortTime(entry) < beforeSessionAt
			);
			const previousEntry = findLatestHistoryEntryWithSeedRows(history) ?? history[0] ?? null;

			return [exerciseId, previousEntry] as const;
		})
	);

	return new Map(
		previousEntries.filter(
			(entry): entry is readonly [string, ExerciseHistoryEntry] => entry[1] !== null
		)
	);
}

function createExerciseRow(
	name: string,
	unilateral = false,
	source: ExerciseSource = 'custom',
	now = timestamp(),
	id = createId()
): Exercise {
	const cleanName = displayName(name);

	return {
		id,
		name: cleanName,
		unilateral,
		source,
		normalizedName: normalizeName(cleanName),
		archived: false,
		createdAt: now,
		updatedAt: now
	};
}

function createBaselineExerciseId(normalizedName: string) {
	return `baseline:${normalizedName}`;
}

function summarizeSession(
	session: WorkoutSession,
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[]
): SessionSummary {
	return {
		...session,
		dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt),
		totalExercises: sessionExercises.length,
		totalSets: sessionSets.length
	};
}

async function getSessionSummariesByIds(sessionIds: string[]) {
	if (sessionIds.length === 0) {
		return new Map<string, SessionSummary>();
	}

	const sessions = (await db.workoutSessions.bulkGet(sessionIds)).filter(isDefined);
	const sessionExercises = await db.sessionExercises.where('sessionId').anyOf(sessionIds).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()).map(
					withSessionSetDefaults
				);
	const sessionExercisesBySessionId = new Map<string, SessionExercise[]>();
	const sessionSetsBySessionId = new Map<string, SessionSet[]>();
	const sessionExerciseById = new Map(
		sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
	);

	for (const sessionExercise of sessionExercises) {
		const rows = sessionExercisesBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionExercise);
		sessionExercisesBySessionId.set(sessionExercise.sessionId, rows);
	}

	for (const sessionSet of sessionSets) {
		const sessionExercise = sessionExerciseById.get(sessionSet.sessionExerciseId);

		if (!sessionExercise) {
			continue;
		}

		const rows = sessionSetsBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionSet);
		sessionSetsBySessionId.set(sessionExercise.sessionId, rows);
	}

	return new Map(
		sessions.map((session) => [
			session.id,
			summarizeSession(
				session,
				sessionExercisesBySessionId.get(session.id) ?? [],
				sessionSetsBySessionId.get(session.id) ?? []
			)
		])
	);
}

export async function ensureBaselineExercises() {
	requireLoggedInUser();

	const normalizedNames = [...BASELINE_EXERCISE_BY_NAME.keys()];
	const existingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(normalizedNames)
		.toArray();
	const existingNames = new Set(existingExercises.map((exercise) => exercise.normalizedName));
	const now = timestamp();
	const missingExercisesByName = new Map<string, Exercise>();

	for (const exercise of BASELINE_EXERCISES) {
		const normalizedName = normalizeName(exercise.name);

		if (existingNames.has(normalizedName) || missingExercisesByName.has(normalizedName)) {
			continue;
		}

		missingExercisesByName.set(
			normalizedName,
			createExerciseRow(
				exercise.name,
				exercise.unilateral,
				'baseline',
				now,
				createBaselineExerciseId(normalizedName)
			)
		);
	}

	const missingExercises = [...missingExercisesByName.values()];

	if (missingExercises.length > 0) {
		await db.exercises.bulkAdd(missingExercises);
	}
}

export async function listExercises() {
	const exercises = dedupeExercises(await db.exercises.toArray());

	return exercises
		.filter((exercise) => !exercise.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listCustomExercises() {
	const exercises = dedupeExercises(await db.exercises.toArray());

	return exercises
		.filter((exercise) => !exercise.archived && exercise.source === 'custom')
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listCustomExerciseItems(): Promise<ExerciseListItem[]> {
	const exercises = await listCustomExercises();
	const exerciseIds = exercises.map((exercise) => exercise.id);

	if (exerciseIds.length === 0) {
		return [];
	}

	const [sessionExercises, resetEvents] = await Promise.all([
		db.sessionExercises.where('exerciseId').anyOf(exerciseIds).toArray(),
		db.exerciseResetEvents.where('exerciseId').anyOf(exerciseIds).toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));

	const historyByExerciseId = new Map<string, Set<string>>();
	const lastPerformedAtByExerciseId = new Map<string, string>();
	const latestResetAtByExerciseId = new Map<string, string>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (!session || session.status === 'planned') {
			continue;
		}

		const historySessions =
			historyByExerciseId.get(sessionExercise.exerciseId) ?? new Set<string>();
		historySessions.add(sessionExercise.sessionId);
		historyByExerciseId.set(sessionExercise.exerciseId, historySessions);

		const currentValue = lastPerformedAtByExerciseId.get(sessionExercise.exerciseId);
		const performedAt = session.startedAt ?? sessionExercise.performedAt;

		if (!currentValue || currentValue < performedAt) {
			lastPerformedAtByExerciseId.set(sessionExercise.exerciseId, performedAt);
		}
	}

	for (const resetEvent of resetEvents) {
		const currentValue = latestResetAtByExerciseId.get(resetEvent.exerciseId);

		if (!currentValue || currentValue < resetEvent.resetAt) {
			latestResetAtByExerciseId.set(resetEvent.exerciseId, resetEvent.resetAt);
		}
	}

	return exercises.map((exercise) => ({
		exercise,
		historyCount: historyByExerciseId.get(exercise.id)?.size ?? 0,
		lastPerformedAt: lastPerformedAtByExerciseId.get(exercise.id),
		latestResetAt: latestResetAtByExerciseId.get(exercise.id)
	}));
}

export async function getExercise(exerciseId: string) {
	const exercise = await db.exercises.get(exerciseId);

	return exercise ? withExerciseDefaults(exercise) : null;
}

export async function createExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const existingExercise = pickPreferredExercise(
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	);

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, inferExerciseSource(normalizedName));
	await db.exercises.add(exercise);

	return exercise;
}

export async function createCustomExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const matchingExercises = (
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	).map(withExerciseDefaults);
	const existingExercise = pickPreferredExercise(matchingExercises);

	if (matchingExercises.some((exercise) => exercise.source === 'baseline')) {
		throw new Error('That name already belongs to a built-in exercise.');
	}

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, 'custom');
	await db.exercises.add(exercise);

	return exercise;
}

export async function setExerciseUnilateral(exerciseId: string, unilateral: boolean) {
	requireLoggedInUser();

	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const updatedAt = timestamp();
	await db.exercises.update(exerciseId, { unilateral, updatedAt });

	return withExerciseDefaults({ ...exercise, unilateral, updatedAt });
}

export async function recordExerciseReset(exerciseId: string) {
	requireLoggedInUser();

	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	const resetEvent: ExerciseResetEvent = {
		id: createId(),
		exerciseId,
		resetAt: now,
		createdAt: now
	};

	await db.exerciseResetEvents.add(resetEvent);

	return resetEvent;
}

export async function listExerciseResetEvents(exerciseId: string) {
	const resetEvents = await db.exerciseResetEvents.where('exerciseId').equals(exerciseId).toArray();

	return resetEvents.sort((first, second) => second.resetAt.localeCompare(first.resetAt));
}

export async function listExerciseHistory(exerciseId: string): Promise<ExerciseHistoryEntry[]> {
	return (await listHistoricalSessionExerciseMatches(exerciseId)).map(
		({ session, sessionExercise, sets }) => ({
			sessionId: session.id,
			workoutId: session.workoutId,
			workoutNameSnapshot: session.workoutNameSnapshot,
			dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt),
			performedAt: sessionExercise.performedAt,
			startedAt: session.startedAt,
			completedAt: session.completedAt,
			status: session.status,
			sets
		})
	);
}

export async function getExerciseDetail(exerciseId: string): Promise<ExerciseDetail | null> {
	const [exercise, history, resetEvents] = await Promise.all([
		getExercise(exerciseId),
		listExerciseHistory(exerciseId),
		listExerciseResetEvents(exerciseId)
	]);

	if (!exercise) {
		return null;
	}

	return {
		exercise,
		history,
		resetEvents
	};
}

export async function listWorkouts() {
	const workouts = await db.workouts.toArray();

	return workouts
		.filter((workout) => !workout.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function createWorkout(name: string) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Workout name is required.');
	}

	const existingWorkout = await db.workouts.where('normalizedName').equals(normalizedName).first();

	if (existingWorkout) {
		if (existingWorkout.archived) {
			const updatedAt = timestamp();
			await db.workouts.update(existingWorkout.id, { archived: false, updatedAt });

			return { ...existingWorkout, archived: false, updatedAt };
		}

		return existingWorkout;
	}

	const now = timestamp();
	const workout: Workout = {
		id: createId(),
		name: cleanName,
		normalizedName,
		archived: false,
		createdAt: now,
		updatedAt: now
	};

	await db.workouts.add(workout);

	return workout;
}

export async function listWorkoutExercises(workoutId: string) {
	const workoutExerciseRows = await db.workoutExercises
		.where('workoutId')
		.equals(workoutId)
		.sortBy('order');
	const exercises = await db.exercises.bulkGet(
		workoutExerciseRows.map((workoutExercise) => workoutExercise.exerciseId)
	);
	const exerciseById = new Map(
		exercises
			.filter(isDefined)
			.map((exercise) => withExerciseDefaults(exercise))
			.map((exercise) => [exercise.id, exercise])
	);

	return workoutExerciseRows
		.map<WorkoutExerciseWithExercise | null>((workoutExercise) => {
			const exercise = exerciseById.get(workoutExercise.exerciseId);

			if (!exercise || exercise.archived) {
				return null;
			}

			return { ...workoutExercise, exercise };
		})
		.filter((workoutExercise): workoutExercise is WorkoutExerciseWithExercise =>
			Boolean(workoutExercise)
		);
}

export async function addExerciseToWorkout(workoutId: string, exerciseId: string) {
	requireLoggedInUser();

	return db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const existingWorkoutExercise = await db.workoutExercises
			.where('[workoutId+exerciseId]')
			.equals([workoutId, exerciseId])
			.first();

		if (existingWorkoutExercise) {
			return existingWorkoutExercise;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const nextOrder =
			workoutExercises.reduce(
				(highestOrder, workoutExercise) => Math.max(highestOrder, workoutExercise.order),
				0
			) + 1;
		const now = timestamp();
		const workoutExercise: WorkoutExercise = {
			id: createId(),
			workoutId,
			exerciseId,
			order: nextOrder,
			createdAt: now,
			updatedAt: now
		};

		await db.workoutExercises.add(workoutExercise);
		await db.workouts.update(workoutId, { updatedAt: now });

		return workoutExercise;
	});
}

async function syncWorkoutExercisesFromSession(sessionId: string, now = timestamp()) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return;
	}

	const [sessionExercises, workoutExercises] = await Promise.all([
		db.sessionExercises.where('sessionId').equals(sessionId).sortBy('order'),
		db.workoutExercises.where('workoutId').equals(session.workoutId).toArray()
	]);
	const workoutExerciseByExerciseId = new Map(
		workoutExercises.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
	);
	const sessionExerciseIdSet = new Set(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId)
	);
	const workoutExerciseIdsToDelete = workoutExercises
		.filter((workoutExercise) => !sessionExerciseIdSet.has(workoutExercise.exerciseId))
		.map((workoutExercise) => workoutExercise.id);
	const nextWorkoutExercises = sessionExercises.map((sessionExercise, index) => {
		const existingWorkoutExercise = workoutExerciseByExerciseId.get(sessionExercise.exerciseId);

		return {
			id: existingWorkoutExercise?.id ?? createId(),
			workoutId: session.workoutId,
			exerciseId: sessionExercise.exerciseId,
			order: index + 1,
			createdAt: existingWorkoutExercise?.createdAt ?? now,
			updatedAt: now
		} satisfies WorkoutExercise;
	});

	if (workoutExerciseIdsToDelete.length > 0) {
		await db.workoutExercises.bulkDelete(workoutExerciseIdsToDelete);
	}

	if (nextWorkoutExercises.length > 0) {
		await db.workoutExercises.bulkPut(nextWorkoutExercises);
	}

	await db.workouts.update(session.workoutId, { updatedAt: now });
}

export async function reorderWorkoutExercises(
	workoutId: string,
	orderedWorkoutExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const workoutExerciseById = new Map(
			workoutExercises.map((workoutExercise) => [workoutExercise.id, workoutExercise])
		);
		const orderedIds = orderedWorkoutExerciseIds.filter((id) => workoutExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = workoutExercises
			.filter((workoutExercise) => !orderedIdSet.has(workoutExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((workoutExercise) => workoutExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.workoutExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutId, { updatedAt: now });
	});
}

export async function moveWorkoutExercise(workoutExerciseId: string, direction: 'up' | 'down') {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');
		const currentIndex = workoutExercises.findIndex((row) => row.id === workoutExerciseId);
		const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

		if (currentIndex < 0 || targetIndex < 0 || targetIndex >= workoutExercises.length) {
			return;
		}

		const currentRow = workoutExercises[currentIndex];
		const targetRow = workoutExercises[targetIndex];
		const now = timestamp();

		await Promise.all([
			db.workoutExercises.update(currentRow.id, { order: targetRow.order, updatedAt: now }),
			db.workoutExercises.update(targetRow.id, { order: currentRow.order, updatedAt: now }),
			db.workouts.update(workoutExercise.workoutId, { updatedAt: now })
		]);
	});
}

export async function removeWorkoutExercise(workoutExerciseId: string) {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const now = timestamp();

		await db.workoutExercises.delete(workoutExerciseId);

		const remainingWorkoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');

		await Promise.all(
			remainingWorkoutExercises.map((remainingWorkoutExercise, index) =>
				db.workoutExercises.update(remainingWorkoutExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutExercise.workoutId, { updatedAt: now });
	});
}

async function getSeedSetOrderCount(exercise: Exercise, excludeSessionId?: string) {
	const latestHistoricalMatch = (await listHistoricalSessionExerciseMatches(exercise.id)).find(
		({ session, sets }) => session.id !== excludeSessionId && sets.length > 0
	);

	if (!latestHistoricalMatch) {
		return 0;
	}

	return getSessionSetOrderCount(latestHistoricalMatch.sets);
}

function createSessionSetRow(
	sessionExerciseId: string,
	exerciseId: string,
	order: number,
	side: SessionSetSide,
	now = timestamp()
): SessionSet {
	return {
		id: createId(),
		sessionExerciseId,
		exerciseId,
		order,
		side,
		weightInput: '',
		repsInput: '',
		rirInput: '',
		createdAt: now,
		updatedAt: now
	};
}

function buildSeedSessionSetRows(
	sessionExerciseId: string,
	exerciseId: string,
	orderCount: number,
	unilateral: boolean,
	now = timestamp()
) {
	const sessionSets: SessionSet[] = [];

	for (let order = 1; order <= orderCount; order += 1) {
		if (unilateral) {
			sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'right', now));
			sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'left', now));
			continue;
		}

		sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'bilateral', now));
	}

	return sessionSets;
}

async function buildSessionSeedSetRows(
	sessionExerciseId: string,
	exercise: Exercise,
	now = timestamp(),
	excludeSessionId?: string
) {
	const orderCount = await getSeedSetOrderCount(exercise, excludeSessionId);

	return buildSeedSessionSetRows(
		sessionExerciseId,
		exercise.id,
		orderCount,
		exercise.unilateral,
		now
	);
}

async function ensureEditableSessionSeedRows(
	session: WorkoutSession,
	sessionExercises: SessionExerciseDetail[]
) {
	if (session.status === 'completed' || session.status === 'abandoned') {
		return sessionExercises;
	}

	const missingSeedRows = sessionExercises.filter(
		(sessionExercise) => sessionExercise.sets.length === 0
	);

	if (missingSeedRows.length === 0) {
		return sessionExercises;
	}

	const exerciseById = new Map(
		(
			await db.exercises.bulkGet(
				missingSeedRows.map((sessionExercise) => sessionExercise.exerciseId)
			)
		)
			.filter(isDefined)
			.map((exercise) => {
				const nextExercise = withExerciseDefaults(exercise);
				return [nextExercise.id, nextExercise] as const;
			})
	);
	const now = timestamp();
	const seedRowsBySessionExerciseId = new Map(
		await Promise.all(
			missingSeedRows.map(async (sessionExercise) => {
				const exercise = exerciseById.get(sessionExercise.exerciseId);

				if (!exercise) {
					return [sessionExercise.id, [] as SessionSet[]] as const;
				}

				return [
					sessionExercise.id,
					await buildSessionSeedSetRows(sessionExercise.id, exercise, now, session.id)
				] as const;
			})
		)
	);
	const seededSessionExerciseIds = [...seedRowsBySessionExerciseId.entries()]
		.filter(([, sessionSets]) => sessionSets.length > 0)
		.map(([sessionExerciseId]) => sessionExerciseId);

	if (seededSessionExerciseIds.length === 0) {
		return sessionExercises;
	}

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		await db.sessionSets.bulkAdd(
			seededSessionExerciseIds.flatMap(
				(sessionExerciseId) => seedRowsBySessionExerciseId.get(sessionExerciseId) ?? []
			)
		);
		await Promise.all(
			seededSessionExerciseIds.map((sessionExerciseId) =>
				db.sessionExercises.update(sessionExerciseId, { updatedAt: now })
			)
		);
		await db.workoutSessions.update(session.id, { updatedAt: now });
	});

	return listSessionExerciseDetails(session.id);
}

async function deleteWorkoutSessionRows(sessionId: string) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const sessionExercises = await db.sessionExercises.where('sessionId').equals(sessionId).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();

	if (sessionSets.length > 0) {
		await db.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
	}

	if (sessionExerciseIds.length > 0) {
		await db.sessionExercises.bulkDelete(sessionExerciseIds);
	}

	await db.workoutSessions.delete(sessionId);

	return session;
}

async function updateSessionSetInputs(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string
) {
	const sessionSet = await db.sessionSets.get(sessionSetId);

	if (!sessionSet) {
		throw new Error('Set not found.');
	}

	const nextSet = withSessionSetDefaults(sessionSet);
	const cleanInputValue = toCleanSessionInputValue(rawValue, field);
	const parsedValue = toParsedInputValue(cleanInputValue, field);
	const updatedAt = timestamp();

	if (field === 'weight') {
		nextSet.weightInput = cleanInputValue;
		nextSet.weight = parsedValue;
	} else if (field === 'reps') {
		nextSet.repsInput = cleanInputValue;
		nextSet.reps = parsedValue;
	} else {
		nextSet.rirInput = cleanInputValue;
		nextSet.rir = parsedValue;
	}

	nextSet.updatedAt = updatedAt;
	await db.sessionSets.put(nextSet);

	return nextSet;
}

export async function cleanupStaleSessions(todayDayKey = toDayKey(new Date())) {
	if (!db.cloud.currentUser.value?.isLoggedIn) {
		return;
	}

	const [plannedSessions, runningSessions] = await Promise.all([
		db.workoutSessions.where('status').equals('planned').toArray(),
		db.workoutSessions.where('status').equals('in_progress').toArray()
	]);
	const stalePlannedSessions = plannedSessions.filter((session) => session.dayKey < todayDayKey);
	const staleRunningSessions = runningSessions.filter((session) => session.dayKey < todayDayKey);

	if (stalePlannedSessions.length === 0 && staleRunningSessions.length === 0) {
		return;
	}

	const now = timestamp();

	await db.transaction('rw', db.workoutSessions, db.sessionExercises, db.sessionSets, async () => {
		for (const stalePlannedSession of stalePlannedSessions) {
			await deleteWorkoutSessionRows(stalePlannedSession.id);
		}

		for (const staleRunningSession of staleRunningSessions) {
			await db.workoutSessions.update(staleRunningSession.id, {
				status: 'abandoned',
				completedAt: now,
				updatedAt: now
			});
		}
	});
}

export async function getCurrentInProgressSession() {
	const sessions = await db.workoutSessions.where('status').equals('in_progress').toArray();
	const latestSession = sessions.sort((first, second) => compareSessionRows(second, first)).at(0);

	if (!latestSession) {
		return null;
	}

	return (await getSessionSummariesByIds([latestSession.id])).get(latestSession.id) ?? null;
}

export async function listSessionSummariesForMonth(monthDate: Date) {
	const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
	const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
	const sessions = await db.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();

	return [...(await getSessionSummariesByIds(sessions.map((session) => session.id))).values()].sort(
		(first, second) => compareSessionRows(first, second)
	);
}

export async function getDayOverview(dayKey: string): Promise<DayOverview> {
	const sessions = await db.workoutSessions.where('dayKey').equals(dayKey).toArray();
	const latestSession = sessions.sort(compareSessionRows).at(-1) ?? null;

	if (!latestSession) {
		return {
			dayKey,
			session: null
		};
	}

	const summaries = await getSessionSummariesByIds([latestSession.id]);

	return {
		dayKey,
		session: summaries.get(latestSession.id) ?? null
	};
}

export async function scheduleWorkoutSession(workoutId: string, dayKey: string) {
	requireLoggedInUser();

	const todayDayKey = toDayKey(new Date());

	if (dayKey !== todayDayKey) {
		throw new Error('You can only schedule a workout for today.');
	}

	await cleanupStaleSessions(todayDayKey);

	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) =>
			session.status === 'planned' ||
			session.status === 'in_progress' ||
			session.status === 'completed' ||
			session.status === 'abandoned'
	);

	if (existingSession) {
		throw new Error('A session already exists for today.');
	}

	const workout = await db.workouts.get(workoutId);

	if (!workout || workout.archived) {
		throw new Error('Workout not found.');
	}

	const workoutExercises = await listWorkoutExercises(workoutId);
	const createdAt = timestamp();
	const session: WorkoutSession = {
		id: createId(),
		workoutId,
		workoutNameSnapshot: workout.name,
		dayKey,
		status: 'planned',
		createdAt,
		updatedAt: createdAt
	};
	const sessionExercises: SessionExercise[] = workoutExercises.map((workoutExercise, index) => ({
		id: createId(),
		sessionId: session.id,
		workoutId,
		exerciseId: workoutExercise.exercise.id,
		exerciseNameSnapshot: workoutExercise.exercise.name,
		order: index + 1,
		performedAt: createdAt,
		createdAt,
		updatedAt: createdAt
	}));
	const sessionSets = (
		await Promise.all(
			sessionExercises.map((sessionExercise, index) =>
				buildSessionSeedSetRows(sessionExercise.id, workoutExercises[index].exercise, createdAt)
			)
		)
	).flat();

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			await db.workoutSessions.add(session);

			if (sessionExercises.length > 0) {
				await db.sessionExercises.bulkAdd(sessionExercises);
			}

			if (sessionSets.length > 0) {
				await db.sessionSets.bulkAdd(sessionSets);
			}

			await db.workouts.update(workoutId, { updatedAt: createdAt });
		}
	);

	return summarizeSession(session, sessionExercises, sessionSets);
}

export async function startWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (session.status === 'completed' || session.status === 'abandoned') {
		return summarizeSession(
			session,
			await db.sessionExercises.where('sessionId').equals(sessionId).toArray(),
			(await listSessionExerciseDetails(sessionId)).flatMap(
				(sessionExercise) => sessionExercise.sets
			)
		);
	}

	if (session.status === 'in_progress' && session.startedAt) {
		return summarizeSession(
			session,
			await db.sessionExercises.where('sessionId').equals(sessionId).toArray(),
			(await listSessionExerciseDetails(sessionId)).flatMap(
				(sessionExercise) => sessionExercise.sets
			)
		);
	}

	const now = timestamp();

	await db.transaction('rw', db.workoutSessions, db.sessionExercises, async () => {
		await db.workoutSessions.update(sessionId, {
			status: 'in_progress',
			startedAt: now,
			updatedAt: now
		});

		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();

		if (sessionExercises.length > 0) {
			await Promise.all(
				sessionExercises.map((sessionExercise) =>
					db.sessionExercises.update(sessionExercise.id, {
						performedAt: now,
						updatedAt: now
					})
				)
			);
		}
	});

	const nextSession = await db.workoutSessions.get(sessionId);
	const nextSessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray();
	const nextSessionSets = (await listSessionExerciseDetails(sessionId)).flatMap(
		(sessionExercise) => sessionExercise.sets
	);

	if (!nextSession) {
		throw new Error('Session not found.');
	}

	await syncCloudAtSessionBoundary();

	return summarizeSession(nextSession, nextSessionExercises, nextSessionSets);
}

export async function reorderSessionExercises(
	sessionId: string,
	orderedSessionExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction('rw', db.sessionExercises, db.workoutSessions, async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseById = new Map(
			sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
		);
		const orderedIds = orderedSessionExerciseIds.filter((id) => sessionExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = sessionExercises
			.filter((sessionExercise) => !orderedIdSet.has(sessionExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((sessionExercise) => sessionExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.sessionExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});
}

export async function replaceSessionExercise(sessionExerciseId: string, exerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const [session, exercise, sessionExercises] = await Promise.all([
		db.workoutSessions.get(sessionExercise.sessionId),
		getExercise(exerciseId),
		db.sessionExercises.where('sessionId').equals(sessionExercise.sessionId).toArray()
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	if (
		sessionExercises.some(
			(candidate) => candidate.id !== sessionExerciseId && candidate.exerciseId === exerciseId
		)
	) {
		throw new Error('That exercise is already in this session.');
	}

	const now = timestamp();
	const seedSets = await buildSessionSeedSetRows(sessionExerciseId, exercise, now, session.id);

	await db.transaction('rw', db.sessionExercises, db.sessionSets, db.workoutSessions, async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();

		if (currentSets.length > 0) {
			await db.sessionSets.bulkDelete(currentSets.map((sessionSet) => sessionSet.id));
		}

		await db.sessionExercises.update(sessionExerciseId, {
			exerciseId: exercise.id,
			exerciseNameSnapshot: exercise.name,
			updatedAt: now
		});

		if (seedSets.length > 0) {
			await db.sessionSets.bulkAdd(seedSets);
		}

		await db.workoutSessions.update(session.id, { updatedAt: now });
	});
}

export async function removeSessionExercise(sessionExerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		return;
	}

	await db.transaction('rw', db.sessionExercises, db.sessionSets, db.workoutSessions, async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();

		if (currentSets.length > 0) {
			await db.sessionSets.bulkDelete(currentSets.map((sessionSet) => sessionSet.id));
		}

		await db.sessionExercises.delete(sessionExerciseId);

		const remainingSessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionExercise.sessionId)
			.sortBy('order');
		const now = timestamp();

		await Promise.all(
			remainingSessionExercises.map((remainingSessionExercise, index) =>
				db.sessionExercises.update(remainingSessionExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});
}

export async function addExerciseToSession(sessionId: string, exerciseId: string) {
	requireLoggedInUser();

	const [session, exercise] = await Promise.all([
		db.workoutSessions.get(sessionId),
		getExercise(exerciseId)
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const existingSessionExercise = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray()
		.then((rows) => rows.find((row) => row.exerciseId === exerciseId));

	if (existingSessionExercise) {
		throw new Error('That exercise is already in this session.');
	}

	const existingSessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray();
	const nextOrder =
		existingSessionExercises.reduce(
			(highestOrder, currentSessionExercise) =>
				Math.max(highestOrder, currentSessionExercise.order),
			0
		) + 1;
	const now = timestamp();
	const sessionExercise: SessionExercise = {
		id: createId(),
		sessionId,
		workoutId: session.workoutId,
		exerciseId: exercise.id,
		exerciseNameSnapshot: exercise.name,
		order: nextOrder,
		performedAt: session.startedAt ?? now,
		createdAt: now,
		updatedAt: now
	};
	const seedSets = await buildSessionSeedSetRows(sessionExercise.id, exercise, now, session.id);

	await db.transaction('rw', db.sessionExercises, db.sessionSets, db.workoutSessions, async () => {
		await db.sessionExercises.add(sessionExercise);

		if (seedSets.length > 0) {
			await db.sessionSets.bulkAdd(seedSets);
		}

		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});

	return sessionExercise;
}

export async function addSessionSetRow(sessionExerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const exercise = await getExercise(sessionExercise.exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const currentSets = await db.sessionSets
		.where('sessionExerciseId')
		.equals(sessionExerciseId)
		.toArray();
	const nextOrder =
		currentSets.reduce((highestOrder, currentSet) => Math.max(highestOrder, currentSet.order), 0) +
		1;
	const now = timestamp();
	const nextSets = buildSeedSessionSetRows(
		sessionExerciseId,
		sessionExercise.exerciseId,
		1,
		exercise.unilateral,
		now
	).map((sessionSet) => ({
		...sessionSet,
		order: nextOrder
	}));

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		await db.sessionSets.bulkAdd(nextSets);
		await db.sessionExercises.update(sessionExerciseId, { updatedAt: now });
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});

	return nextSets.map(withSessionSetDefaults).sort(compareSessionSetRows);
}

export async function removeSessionSetRow(sessionSetId: string) {
	requireLoggedInUser();

	const sessionSet = await db.sessionSets.get(sessionSetId);

	if (!sessionSet) {
		return;
	}

	const sessionExercise = await db.sessionExercises.get(sessionSet.sessionExerciseId);

	if (!sessionExercise) {
		await db.sessionSets.delete(sessionSetId);
		return;
	}

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionSet.sessionExerciseId)
			.toArray();
		const deleteSetIds = currentSets
			.filter((currentSet) => currentSet.order === sessionSet.order)
			.map((currentSet) => currentSet.id);

		if (deleteSetIds.length > 0) {
			await db.sessionSets.bulkDelete(deleteSetIds);
		}

		const remainingSets = currentSets
			.filter((currentSet) => !deleteSetIds.includes(currentSet.id))
			.sort(compareSessionSetRows);
		const uniqueOrders = [...new Set(remainingSets.map((currentSet) => currentSet.order))].sort(
			(first, second) => first - second
		);
		const nextOrderByCurrentOrder = new Map(
			uniqueOrders.map((order, index) => [order, index + 1] as const)
		);
		const now = timestamp();

		await Promise.all(
			remainingSets.map((remainingSet) => {
				const nextOrder = nextOrderByCurrentOrder.get(remainingSet.order) ?? remainingSet.order;

				if (nextOrder === remainingSet.order) {
					return Promise.resolve(0);
				}

				return db.sessionSets.update(remainingSet.id, {
					order: nextOrder,
					updatedAt: now
				});
			})
		);
		await db.sessionExercises.update(sessionExercise.id, { updatedAt: now });
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});
}

export async function updateSessionSetInput(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string
) {
	requireLoggedInUser();

	return updateSessionSetInputs(sessionSetId, field, rawValue);
}

export async function resetSessionInputs(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	const workoutExercises = await listWorkoutExercises(session.workoutId);
	const now = timestamp();
	const nextSessionExercises: SessionExercise[] = workoutExercises.map(
		(workoutExercise, index) => ({
			id: createId(),
			sessionId,
			workoutId: session.workoutId,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: session.startedAt ?? now,
			createdAt: now,
			updatedAt: now
		})
	);
	const nextSessionSets = (
		await Promise.all(
			nextSessionExercises.map((sessionExercise, index) =>
				buildSessionSeedSetRows(
					sessionExercise.id,
					workoutExercises[index].exercise,
					now,
					sessionId
				)
			)
		)
	).flat();

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);

		if (sessionExerciseIds.length > 0) {
			const sessionSets = await db.sessionSets
				.where('sessionExerciseId')
				.anyOf(sessionExerciseIds)
				.toArray();

			if (sessionSets.length > 0) {
				await db.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
			}

			await db.sessionExercises.bulkDelete(sessionExerciseIds);
		}

		if (nextSessionExercises.length > 0) {
			await db.sessionExercises.bulkAdd(nextSessionExercises);
		}

		if (nextSessionSets.length > 0) {
			await db.sessionSets.bulkAdd(nextSessionSets);
		}

		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});
}

export async function completeWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (session.status === 'completed' || session.status === 'abandoned') {
		return;
	}

	const now = timestamp();

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.workoutExercises,
		db.workouts,
		async () => {
			await syncWorkoutExercisesFromSession(sessionId, now);
			await db.workoutSessions.update(sessionId, {
				status: 'completed',
				startedAt: session.startedAt ?? now,
				completedAt: now,
				updatedAt: now
			});
		}
	);

	await syncCloudAtSessionBoundary();
}

export async function getSessionOverview(sessionId: string): Promise<SessionOverview | null> {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const currentSessionAt = getSessionSortTime(session);
	const [sessionExercises, previousSession, exercises] = await Promise.all([
		listSessionExerciseDetails(sessionId),
		db.workoutSessions
			.where('workoutId')
			.equals(session.workoutId)
			.toArray()
			.then(
				(sessions) =>
					sessions
						.filter(
							(candidate) =>
								candidate.id !== session.id &&
								candidate.status !== 'planned' &&
								getSessionSortTime(candidate) < currentSessionAt
						)
						.sort(compareSessionRows)
						.at(-1) ?? null
			),
		db.exercises.bulkGet(
			(await db.sessionExercises.where('sessionId').equals(sessionId).toArray()).map(
				(sessionExercise) => sessionExercise.exerciseId
			)
		)
	]);
	const sessionSets = sessionExercises.flatMap((sessionExercise) => sessionExercise.sets);
	const previousExercises = previousSession
		? await listSessionExerciseDetails(previousSession.id)
		: [];
	const previousSummary = previousSession
		? summarizeSession(
				previousSession,
				previousExercises,
				previousExercises.flatMap((sessionExercise) => sessionExercise.sets)
			)
		: null;
	const exerciseById = new Map(
		exercises.filter(isDefined).map((exercise) => {
			const nextExercise = withExerciseDefaults(exercise);
			return [nextExercise.id, nextExercise] as const;
		})
	);
	const historyEntriesByExerciseId = new Map(
		await Promise.all(
			[...new Set(sessionExercises.map((sessionExercise) => sessionExercise.exerciseId))].map(
				async (exerciseId) =>
					[
						exerciseId,
						(await listExerciseHistory(exerciseId)).filter(
							(entry) =>
								entry.sessionId !== session.id &&
								getExerciseHistorySortTime(entry) < currentSessionAt
						)
					] as const
			)
		)
	);
	const previousPerformanceByExerciseId = await getLatestExerciseHistoryEntries(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId),
		session.id,
		currentSessionAt
	);
	const progress =
		sessionExercises.length === 0
			? null
			: {
					improvedExercises: 0,
					matchedExercises: 0,
					regressedExercises: 0,
					mixedExercises: 0,
					newExercises: 0
				};
	const nextExercises = sessionExercises.map((sessionExercise) => {
		const historyEntries = historyEntriesByExerciseId.get(sessionExercise.exerciseId) ?? [];
		const previousReferenceBySetKey = buildPreviousReferenceBySetKey(
			sessionExercise,
			historyEntries
		);
		const previousPerformance =
			previousPerformanceByExerciseId.get(sessionExercise.exerciseId) ?? null;
		const { progressStatus, progressSummary } = summarizeExerciseProgress(
			sessionExercise,
			previousReferenceBySetKey
		);
		const sets = sessionExercise.sets.map((sessionSet) => {
			const previousReference = previousReferenceBySetKey.get(getSessionSetKey(sessionSet)) ?? null;

			return {
				...sessionSet,
				label: getSessionSetLabel(sessionSet),
				previousReference,
				weightDelta: createFieldDelta(sessionSet.weight, previousReference?.weight),
				repsDelta: createFieldDelta(sessionSet.reps, previousReference?.reps),
				rirDelta: createFieldDelta(sessionSet.rir, previousReference?.rir)
			};
		});

		if (progress) {
			switch (progressStatus) {
				case 'improved':
					progress.improvedExercises += 1;
					break;
				case 'regressed':
					progress.regressedExercises += 1;
					break;
				case 'mixed':
					progress.mixedExercises += 1;
					break;
				case 'new':
					progress.newExercises += 1;
					break;
				default:
					progress.matchedExercises += 1;
			}
		}

		return {
			...sessionExercise,
			exercise: exerciseById.get(sessionExercise.exerciseId) ?? null,
			previousPerformance,
			progressStatus,
			progressSummary,
			sets
		};
	});

	return {
		summary: summarizeSession(session, sessionExercises, sessionSets),
		previousSummary,
		progress,
		exercises: nextExercises
	};
}

export async function getEditableSession(sessionId: string) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	await ensureEditableSessionSeedRows(session, await listSessionExerciseDetails(sessionId));

	return getSessionOverview(sessionId);
}

export async function deleteWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			const session = await deleteWorkoutSessionRows(sessionId);

			if (!session) {
				return;
			}

			await db.workouts.update(session.workoutId, { updatedAt: timestamp() });
		}
	);
}

function toBackfillSessionDate(dayKey: string, timeValue: string) {
	const cleanDayKey = dayKey.trim();
	const cleanTimeValue = timeValue.trim() || '12:00';
	const date = new Date(`${cleanDayKey}T${cleanTimeValue}`);

	if (!cleanDayKey || Number.isNaN(date.getTime())) {
		throw new Error('Choose a valid backfill date.');
	}

	return date;
}

export async function createBackfillWorkoutSession(input: BackfillWorkoutSessionInput) {
	requireLoggedInUser();

	const workout = await db.workouts.get(input.workoutId);

	if (!workout || workout.archived) {
		throw new Error('Workout not found.');
	}

	const workoutExercises = await listWorkoutExercises(workout.id);

	if (workoutExercises.length === 0) {
		throw new Error('Add exercises to this workout before backfilling it.');
	}

	const workoutExerciseByExerciseId = new Map(
		workoutExercises.map((workoutExercise) => [workoutExercise.exercise.id, workoutExercise])
	);
	const includedExercises = input.exercises
		.map((entry) => ({
			...entry,
			workoutExercise: workoutExerciseByExerciseId.get(entry.exerciseId) ?? null,
			sets: entry.sets.filter(
				(set) => set.weightInput?.trim() || set.repsInput?.trim() || set.rirInput?.trim()
			)
		}))
		.filter((entry) => entry.workoutExercise && entry.sets.length > 0);

	if (includedExercises.length === 0) {
		throw new Error('Log at least one set before saving.');
	}

	const startedAtDate = toBackfillSessionDate(input.dayKey, input.startTime);
	const durationMinutes =
		Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
			? input.durationMinutes
			: 60;
	const completedAtDate = new Date(startedAtDate.getTime() + durationMinutes * 60 * 1000);
	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey: toDayKey(startedAtDate),
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};
	const sessionExercises: SessionExercise[] = includedExercises.map((entry, index) => {
		const workoutExercise = entry.workoutExercise as WorkoutExerciseWithExercise;

		return {
			id: createId(),
			sessionId,
			workoutId: workout.id,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: timestamp(new Date(startedAtDate.getTime() + index * 8 * 60 * 1000)),
			createdAt: startedAt,
			updatedAt: completedAt
		};
	});
	const sessionSets: SessionSet[] = sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
		includedExercises[exerciseIndex].sets.map((set, setIndex) => {
			const weightInput = toCleanSessionInputValue(set.weightInput ?? '', 'weight');
			const repsInput = toCleanSessionInputValue(set.repsInput ?? '', 'reps');
			const rirInput = toCleanSessionInputValue(set.rirInput ?? '', 'rir');

			return {
				id: createId(),
				sessionExerciseId: sessionExercise.id,
				exerciseId: sessionExercise.exerciseId,
				order:
					typeof set.order === 'number' && Number.isFinite(set.order) && set.order > 0
						? set.order
						: setIndex + 1,
				side: normalizeSessionSetSide(set.side),
				weightInput,
				repsInput,
				rirInput,
				weight: toParsedInputValue(weightInput, 'weight'),
				reps: toParsedInputValue(repsInput, 'reps'),
				rir: toParsedInputValue(rirInput, 'rir'),
				createdAt: timestamp(
					new Date(startedAtDate.getTime() + (exerciseIndex * 8 + setIndex * 3) * 60 * 1000)
				),
				updatedAt: completedAt
			};
		})
	);

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			await db.workoutSessions.add(session);
			await db.sessionExercises.bulkAdd(sessionExercises);
			await db.sessionSets.bulkAdd(sessionSets);
			await db.workouts.update(workout.id, { updatedAt: completedAt });
		}
	);

	await syncCloudAtSessionBoundary();

	return summarizeSession(session, sessionExercises, sessionSets);
}

function createExampleStartedAt(daysAgo: number, hours: number, minutes: number) {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hours, minutes, 0, 0);

	return date;
}

type ExampleSetSeed = Pick<SessionSet, 'weight' | 'reps' | 'rir'>;

type ExampleSessionSeed = {
	daysAgo: number;
	startedAt: {
		hours: number;
		minutes: number;
	};
	completedAt: {
		hours: number;
		minutes: number;
	};
	setsByExercise: ExampleSetSeed[][];
};

const EXAMPLE_BASELINE_SETS: ExampleSetSeed[][] = [
	[
		{ weight: 60, reps: 8, rir: 2 },
		{ weight: 65, reps: 8, rir: 1 },
		{ weight: 67.5, reps: 6, rir: 1 }
	],
	[
		{ reps: 10, rir: 2 },
		{ reps: 9, rir: 1 },
		{ reps: 8, rir: 1 }
	],
	[
		{ weight: 10, reps: 15, rir: 2 },
		{ weight: 12.5, reps: 12, rir: 1 },
		{ weight: 12.5, reps: 12, rir: 1 }
	]
];

const EXAMPLE_IMPROVEMENT_SETS: ExampleSetSeed[][] = [
	[
		{ weight: 62.5, reps: 8, rir: 2 },
		{ weight: 67.5, reps: 8, rir: 1 },
		{ weight: 70, reps: 6, rir: 1 }
	],
	[
		{ reps: 11, rir: 2 },
		{ reps: 10, rir: 1 },
		{ weight: 2.5, reps: 8, rir: 1 }
	],
	[
		{ weight: 12.5, reps: 15, rir: 2 },
		{ weight: 15, reps: 12, rir: 1 },
		{ weight: 15, reps: 12, rir: 1 }
	]
];

async function listExampleBaselineExercises() {
	const preferredExerciseByNormalizedName = await getPreferredExerciseByNormalizedNames(
		EXAMPLE_EXERCISE_NAMES.map((name) => normalizeName(name))
	);

	return EXAMPLE_EXERCISE_NAMES.map((name) =>
		preferredExerciseByNormalizedName.get(normalizeName(name))
	).filter(isDefined);
}

async function normalizeExampleSessionExerciseIds(sessionId: string) {
	const sessionExercises = await db.sessionExercises.where('sessionId').equals(sessionId).toArray();
	const preferredExerciseByNormalizedName = await getPreferredExerciseByNormalizedNames(
		sessionExercises.map((sessionExercise) => normalizeName(sessionExercise.exerciseNameSnapshot))
	);
	const exerciseIdsBySessionExerciseId = new Map(
		sessionExercises.flatMap((sessionExercise) => {
			const preferredExercise = preferredExerciseByNormalizedName.get(
				normalizeName(sessionExercise.exerciseNameSnapshot)
			);

			return preferredExercise ? ([[sessionExercise.id, preferredExercise.id]] as const) : [];
		})
	);
	const now = timestamp();

	await db.transaction('rw', db.sessionExercises, db.sessionSets, async () => {
		for (const sessionExercise of sessionExercises) {
			const nextExerciseId = exerciseIdsBySessionExerciseId.get(sessionExercise.id);

			if (!nextExerciseId || sessionExercise.exerciseId === nextExerciseId) {
				continue;
			}

			await db.sessionExercises.update(sessionExercise.id, {
				exerciseId: nextExerciseId,
				updatedAt: now
			});
		}

		if (sessionExercises.length === 0) {
			return;
		}

		const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
		const sessionSets = await db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExerciseIds)
			.toArray();

		for (const sessionSet of sessionSets) {
			const nextExerciseId = exerciseIdsBySessionExerciseId.get(sessionSet.sessionExerciseId);

			if (!nextExerciseId || sessionSet.exerciseId === nextExerciseId) {
				continue;
			}

			await db.sessionSets.update(sessionSet.id, {
				exerciseId: nextExerciseId,
				updatedAt: now
			});
		}
	});
}

async function ensureExampleWorkoutSetup() {
	requireLoggedInUser();

	await ensureBaselineExercises();

	const workout = await createWorkout(EXAMPLE_WORKOUT_NAME);
	const exercises = await listExampleBaselineExercises();

	for (const exercise of exercises) {
		await addExerciseToWorkout(workout.id, exercise.id);
	}

	return {
		workout,
		exercises
	};
}

async function seedExampleSession(seed: ExampleSessionSeed): Promise<BackfillSeedResult> {
	const { workout, exercises } = await ensureExampleWorkoutSetup();
	const startedAtDate = createExampleStartedAt(
		seed.daysAgo,
		seed.startedAt.hours,
		seed.startedAt.minutes
	);
	const completedAtDate = createExampleStartedAt(
		seed.daysAgo,
		seed.completedAt.hours,
		seed.completedAt.minutes
	);
	const dayKey = toDayKey(startedAtDate);
	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) =>
			session.workoutId === workout.id && session.workoutNameSnapshot === EXAMPLE_WORKOUT_NAME
	);

	if (existingSession) {
		await normalizeExampleSessionExerciseIds(existingSession.id);

		return {
			workoutId: workout.id,
			sessionId: existingSession.id,
			created: false
		};
	}

	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey,
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};

	await db.workoutSessions.add(session);

	const sessionExercises: SessionExercise[] = exercises.map((exercise, index) => ({
		id: createId(),
		sessionId,
		workoutId: workout.id,
		exerciseId: exercise.id,
		exerciseNameSnapshot: exercise.name,
		order: index + 1,
		performedAt: timestamp(new Date(startedAtDate.getTime() + index * 12 * 60 * 1000)),
		createdAt: startedAt,
		updatedAt: completedAt
	}));

	await db.sessionExercises.bulkAdd(sessionExercises);

	await db.sessionSets.bulkAdd(
		sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
			(seed.setsByExercise[exerciseIndex] ?? []).map((set, setIndex) => ({
				id: createId(),
				sessionExerciseId: sessionExercise.id,
				exerciseId: sessionExercise.exerciseId,
				order: setIndex + 1,
				side: 'bilateral' as const,
				weightInput: toStoredInputValue(undefined, set.weight),
				repsInput: toStoredInputValue(undefined, set.reps),
				rirInput: toStoredInputValue(undefined, set.rir),
				weight: set.weight,
				reps: set.reps,
				rir: set.rir,
				createdAt: timestamp(
					new Date(startedAtDate.getTime() + (exerciseIndex * 12 + setIndex * 3) * 60 * 1000)
				),
				updatedAt: completedAt
			}))
		)
	);

	return {
		workoutId: workout.id,
		sessionId,
		created: true
	};
}

export async function seedExampleBackfill(): Promise<BackfillSeedResult> {
	return seedExampleSession({
		daysAgo: 2,
		startedAt: {
			hours: 18,
			minutes: 10
		},
		completedAt: {
			hours: 18,
			minutes: 58
		},
		setsByExercise: EXAMPLE_BASELINE_SETS
	});
}

export async function seedImprovedBackfill(): Promise<BackfillSeedResult> {
	await seedExampleBackfill();

	return seedExampleSession({
		daysAgo: 1,
		startedAt: {
			hours: 18,
			minutes: 12
		},
		completedAt: {
			hours: 19,
			minutes: 1
		},
		setsByExercise: EXAMPLE_IMPROVEMENT_SETS
	});
}
