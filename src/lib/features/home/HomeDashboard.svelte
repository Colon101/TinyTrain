<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { onMount } from 'svelte';
	import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { DayOverview, SessionSummary, Workout } from '$lib/db';
	import { toDayKey } from '$lib/db';
	import InstallPrompt from '$lib/InstallPrompt.svelte';
	import ProfileMenu from '$lib/features/app/ProfileMenu.svelte';
	import type { CloudUser } from '$lib/features/app/user';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		addMonths,
		addWeeks,
		fromDayKey,
		getMonthCacheKey,
		startOfMonth,
		startOfWeek
	} from './calendar';
	import DayOverviewPanel from './DayOverviewPanel.svelte';
	import DayPickerSheet from './DayPickerSheet.svelte';
	import HomeCalendar from './HomeCalendar.svelte';
	import WorkoutPickerSheet from './WorkoutPickerSheet.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type SessionCache = Record<string, SessionSummary[]>;
	type SubscriptionLike = {
		unsubscribe(): void;
	};

	let api = $state<DatabaseApi | null>(null);
	let currentUser = $state<CloudUser>({ isLoading: true });
	let isLoading = $state(true);
	let isMutating = $state(false);
	let errorMessage = $state('');
	let selectedDayKey = $state(toDayKey(new Date()));
	let visibleWeekDate = $state(startOfWeek(new Date()));
	let pickerMonthDate = $state(startOfMonth(new Date()));
	let isDayPickerOpen = $state(false);
	let isWorkoutPickerOpen = $state(false);
	let weekSlideDirection = $state<-1 | 0 | 1>(0);
	let sessionsByMonthKey = $state<SessionCache>({});
	let dayOverview = $state<DayOverview | null>(null);
	let currentSession = $state<SessionSummary | null>(null);
	let workouts = $state<Workout[]>([]);

	let todayDayKey = $derived(toDayKey(new Date()));
	let urlDateParam = $derived(page.url.searchParams.get('date'));
	let urlDayKey = $derived(getUrlDayKey(urlDateParam));
	let sessionByDayKey = $derived.by(() => {
		const nextMap = new SvelteMap<string, SessionSummary>();
		const getSortValue = (session: SessionSummary) => session.startedAt ?? session.createdAt;

		for (const monthSessions of Object.values(sessionsByMonthKey)) {
			for (const session of monthSessions) {
				const existing = nextMap.get(session.dayKey);

				if (!existing || getSortValue(existing) < getSortValue(session)) {
					nextMap.set(session.dayKey, session);
				}
			}
		}

		return nextMap;
	});

	$effect(() => {
		const nextDayKey = urlDayKey ?? todayDayKey;

		if (nextDayKey !== untrack(() => selectedDayKey)) {
			void updateSelectedDay(nextDayKey, 0, false);
		}
	});

	onMount(() => {
		let disposed = false;
		let currentUserSubscription: SubscriptionLike | null = null;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				await dbApi.ensureDbOpen();
				await dbApi.cleanupStaleSessions(todayDayKey);
				currentUserSubscription = dbApi.db.cloud.currentUser.subscribe((nextUser) => {
					currentUser = nextUser;
				});
				await refreshSelectedDay();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
			} finally {
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
			currentUserSubscription?.unsubscribe();
		};
	});

	async function reloadMonth(monthDate: Date) {
		if (!api) {
			return;
		}

		const monthKey = getMonthCacheKey(monthDate);
		const sessions = await api.listSessionSummariesForMonth(monthDate);
		sessionsByMonthKey = {
			...sessionsByMonthKey,
			[monthKey]: sessions
		};
	}

	async function ensureMonthLoaded(monthDate: Date) {
		if (!api) {
			return;
		}

		const monthKey = getMonthCacheKey(monthDate);

		if (sessionsByMonthKey[monthKey]) {
			return;
		}

		await reloadMonth(monthDate);
	}

	async function ensureWeekLoaded(weekDate: Date) {
		const monthKeys = new SvelteSet<string>();
		const monthDates: Date[] = [];

		for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
			const dayDate = new SvelteDate(weekDate);
			dayDate.setDate(weekDate.getDate() + dayIndex);
			const monthDate = startOfMonth(dayDate);
			const monthKey = getMonthCacheKey(monthDate);

			if (!monthKeys.has(monthKey)) {
				monthKeys.add(monthKey);
				monthDates.push(monthDate);
			}
		}

		await Promise.all(monthDates.map((monthDate) => ensureMonthLoaded(monthDate)));
	}

	async function refreshSelectedDay() {
		if (!api) {
			return;
		}

		await api.cleanupStaleSessions(todayDayKey);
		await ensureWeekLoaded(visibleWeekDate);
		dayOverview = await api.getDayOverview(selectedDayKey);
		currentSession = await api.getCurrentInProgressSession();
		workouts = await api.listWorkouts();
	}

	async function runMutation(action: () => Promise<void>) {
		isMutating = true;
		errorMessage = '';

		try {
			await action();
			sessionsByMonthKey = {};
			await refreshSelectedDay();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			isMutating = false;
		}
	}

	function getUrlDayKey(value: string | null) {
		if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			return null;
		}

		return toDayKey(fromDayKey(value)) === value ? value : null;
	}

	function updateSelectedDateUrl(dayKey: string) {
		const nextDateParam = dayKey === todayDayKey ? null : dayKey;

		if (page.url.searchParams.get('date') === nextDateParam) {
			return;
		}

		const nextUrl = new URL(page.url);
		if (nextDateParam) {
			nextUrl.searchParams.set('date', nextDateParam);
		} else {
			nextUrl.searchParams.delete('date');
		}
		void goto(`${nextUrl.pathname}${nextUrl.search}`, {
			keepFocus: true,
			noScroll: true,
			replaceState: true
		});
	}

	async function updateSelectedDay(
		dayKey: string,
		nextSlideDirection: -1 | 0 | 1 = 0,
		shouldUpdateUrl = true
	) {
		if (!api) {
			selectedDayKey = dayKey;
			visibleWeekDate = startOfWeek(fromDayKey(dayKey));
			pickerMonthDate = startOfMonth(fromDayKey(dayKey));
			weekSlideDirection = nextSlideDirection;
			return;
		}

		const nextWeekDate = startOfWeek(fromDayKey(dayKey));
		selectedDayKey = dayKey;
		visibleWeekDate = nextWeekDate;
		pickerMonthDate = startOfMonth(fromDayKey(dayKey));
		weekSlideDirection = nextSlideDirection;

		if (shouldUpdateUrl) {
			updateSelectedDateUrl(dayKey);
		}

		try {
			await refreshSelectedDay();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		}
	}

	function selectDay(dayKey: string) {
		void updateSelectedDay(dayKey);
	}

	function shiftWeek(delta: -1 | 1) {
		const nextDay = addWeeks(fromDayKey(selectedDayKey), delta);
		void updateSelectedDay(toDayKey(nextDay), delta);
	}

	function openDayPicker() {
		pickerMonthDate = startOfMonth(fromDayKey(selectedDayKey));
		isDayPickerOpen = true;
		void ensureMonthLoaded(pickerMonthDate);
	}

	function closeDayPicker() {
		isDayPickerOpen = false;
	}

	function showPreviousPickerMonth() {
		const nextMonthDate = addMonths(pickerMonthDate, -1);
		pickerMonthDate = nextMonthDate;
		void ensureMonthLoaded(nextMonthDate);
	}

	function showNextPickerMonth() {
		const nextMonthDate = addMonths(pickerMonthDate, 1);
		pickerMonthDate = nextMonthDate;
		void ensureMonthLoaded(nextMonthDate);
	}

	function openWorkoutPicker() {
		if (workouts.length === 0) {
			void goto(resolve('/workouts'));
			return;
		}

		isWorkoutPickerOpen = true;
	}

	function closeWorkoutPicker() {
		isWorkoutPickerOpen = false;
	}

	function scheduleWorkout(workoutId: string) {
		const dbApi = api;

		if (!dbApi) {
			return;
		}

		void runMutation(async () => {
			await dbApi.scheduleWorkoutSession(workoutId, selectedDayKey);
			isWorkoutPickerOpen = false;
		});
	}

	function startSession(sessionId: string) {
		const dbApi = api;

		if (!dbApi) {
			return;
		}

		void runMutation(async () => {
			await dbApi.startWorkoutSession(sessionId);
			await goto(resolve('/(app)/sessions/[sessionId]', { sessionId }));
		});
	}
</script>

<section class="flex flex-1 flex-col">
	<div class="flex items-center justify-between gap-3 pb-3">
		<p class="text-lg font-semibold text-white">TinyTrain</p>

		<div class="flex items-center gap-2">
			<button
				class="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition hover:border-emerald-300/40 hover:bg-white/[0.08]"
				type="button"
				title="Open calendar"
				onclick={openDayPicker}
			>
				<Icon name="calendar" class="h-4 w-4" />
			</button>
			<ProfileMenu user={currentUser} />
		</div>
	</div>

	{#if errorMessage}
		<p
			class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{:else if isLoading}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h2 class="mt-5 text-2xl font-semibold text-white">Loading</h2>
		</section>
	{:else}
		<HomeCalendar
			weekDate={visibleWeekDate}
			{selectedDayKey}
			{sessionByDayKey}
			slideDirection={weekSlideDirection}
			onSelectDay={selectDay}
			onShiftWeek={shiftWeek}
		/>

		<DayOverviewPanel
			overview={dayOverview}
			{currentSession}
			isTodaySelected={selectedDayKey === todayDayKey}
			isBusy={isMutating}
			onOpenScheduleWorkout={openWorkoutPicker}
			onStartSession={startSession}
		/>

		<div class="mt-auto grid gap-3 pt-4">
			<a
				class="flex min-h-12 items-center justify-between rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href={resolve('/workouts')}
			>
				<span class="flex items-center gap-3">
					<Icon name="dumbbell" class="h-5 w-5" />
					Open workouts
				</span>
				<Icon name="arrow-right" class="h-4 w-4" />
			</a>
			<a
				class="flex min-h-12 items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white"
				href={resolve('/exercises')}
			>
				<span class="flex items-center gap-3">
					<Icon name="activity" class="h-5 w-5 text-emerald-200" />
					Open exercises
				</span>
				<Icon name="arrow-right" class="h-4 w-4" />
			</a>

			<InstallPrompt />
		</div>
	{/if}
</section>

{#if isDayPickerOpen}
	<DayPickerSheet
		monthDate={pickerMonthDate}
		{selectedDayKey}
		{sessionByDayKey}
		onSelectDay={selectDay}
		onClose={closeDayPicker}
		onPreviousMonth={showPreviousPickerMonth}
		onNextMonth={showNextPickerMonth}
	/>
{/if}

{#if isWorkoutPickerOpen}
	<WorkoutPickerSheet
		{workouts}
		isSaving={isMutating}
		onClose={closeWorkoutPicker}
		onPickWorkout={scheduleWorkout}
	/>
{/if}
