<script lang="ts">
	import { resolve } from '$app/paths';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import type { SessionOverview } from '$lib/db';
	import ProfileMenu from '$lib/features/app/ProfileMenu.svelte';
	import {
		SESSION_EDIT_DISCARD_MESSAGE,
		clearSessionEditDraft,
		readSessionEditDraft,
		sessionOverviewActions
	} from '$lib/features/sessions/session-overview-actions';
	import type { SessionEditDraft } from '$lib/features/sessions/session-overview-actions';
	import { formatDuration, formatSessionStatus } from '$lib/features/sessions/session-format';
	import type { CloudUser } from '$lib/features/app/user';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type SubscriptionLike = {
		unsubscribe(): void;
	};
	type SessionTimerSummary = Pick<
		SessionOverview['summary'],
		'id' | 'status' | 'startedAt' | 'completedAt' | 'workoutNameSnapshot' | 'dayKey'
	>;

	const CALLBACK_TIMEOUT_MS = 15000;

	let { children } = $props();

	let currentUser = $state<CloudUser>({ isLoading: true });
	let isCheckingAuth = $state(true);
	let authError = $state('');
	let callbackTimedOut = $state(false);
	let isHandlingOAuthCallback = $derived(page.url.searchParams.has('code'));
	let isHomePage = $derived(page.url.pathname === '/');
	let nowMs = $state(Date.now());
	let sessionMatch = $derived(page.url.pathname.match(/^\/sessions\/([^/]+)/));
	let isSessionOverviewPage = $derived(Boolean(page.url.pathname.match(/^\/sessions\/[^/]+$/)));
	let isSessionEditRoute = $derived(
		Boolean(sessionMatch && page.url.searchParams.get('edit') === '1')
	);
	let sessionTimer = $state<SessionTimerSummary | null>(null);
	let sessionEditDraft = $state<SessionEditDraft | null>(null);
	let isSessionActionsMenuOpen = $state(false);
	let sessionActionsMenuContainer = $state<HTMLElement | null>(null);
	let displayedSessionTimer = $derived(
		sessionTimer && isSessionEditRoute
			? {
					...sessionTimer,
					startedAt: sessionEditDraft?.startedAt || sessionTimer.startedAt,
					completedAt: sessionEditDraft?.completedAt || sessionTimer.completedAt
				}
			: sessionTimer
	);
	let showSessionTimer = $derived(
		Boolean(
			displayedSessionTimer?.startedAt &&
			(displayedSessionTimer.status === 'in_progress' || isSessionEditRoute)
		)
	);
	let showSessionStatus = $derived(
		Boolean(
			displayedSessionTimer && displayedSessionTimer.status !== 'planned' && !showSessionTimer
		)
	);
	let sessionTimerNowMs = $derived(
		isSessionEditRoute && displayedSessionTimer?.completedAt
			? new Date(displayedSessionTimer.completedAt).getTime()
			: nowMs
	);
	let todayDayKey = $derived(getDayKey(new Date()));

	onMount(() => {
		let disposed = false;
		let currentUserSubscription: SubscriptionLike | null = null;
		let callbackTimeoutId: ReturnType<typeof setTimeout> | null = null;

		function clearCallbackTimeout() {
			if (callbackTimeoutId) {
				clearTimeout(callbackTimeoutId);
				callbackTimeoutId = null;
			}
		}

		function handlePointerDown(event: PointerEvent) {
			const target = event.target as Node | null;

			if (sessionActionsMenuContainer && target && !sessionActionsMenuContainer.contains(target)) {
				isSessionActionsMenuOpen = false;
			}
		}

		window.addEventListener('pointerdown', handlePointerDown, { capture: true });

		void (async () => {
			try {
				const supabaseAuth = await import('$lib/supabase');

				if (await supabaseAuth.reloadOnceAfterSupabaseOAuthCallback('/')) {
					return;
				}

				const api = (await import('$lib/db')) as DatabaseApi;

				if (disposed) {
					return;
				}

				currentUserSubscription = api.db.cloud.currentUser.subscribe((nextUser) => {
					currentUser = nextUser;

					if (nextUser.isLoading) {
						isCheckingAuth = true;
						return;
					}

					clearCallbackTimeout();

					if (!nextUser.isLoggedIn) {
						void goto(resolve('/login'), { replaceState: true });
						return;
					}

					authError = '';
					callbackTimedOut = false;
					isCheckingAuth = false;
				});

				if (window.location.search.includes('code=')) {
					callbackTimeoutId = setTimeout(() => {
						callbackTimedOut = true;
						authError = 'Google sign-in did not finish. Try again from the sign-in page.';
						isCheckingAuth = false;
					}, CALLBACK_TIMEOUT_MS);
				}

				void api.ensureDbOpen().catch((error) => {
					authError = error instanceof Error ? error.message : 'Failed to open local storage.';
					isCheckingAuth = false;
				});
			} catch (error) {
				clearCallbackTimeout();
				authError = error instanceof Error ? error.message : 'Failed to open local storage.';
				isCheckingAuth = false;
			}
		})();

		return () => {
			disposed = true;
			clearCallbackTimeout();
			window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
			currentUserSubscription?.unsubscribe();
		};
	});

	beforeNavigate((navigation) => {
		const sessionId = sessionMatch?.[1];

		if (
			!sessionId ||
			!isSessionEditRoute ||
			navigation.type === 'goto' ||
			isSavingEditNavigation(navigation.to?.url)
		) {
			return;
		}

		if (window.confirm(SESSION_EDIT_DISCARD_MESSAGE)) {
			clearSessionEditDraft(sessionId);
			sessionEditDraft = null;
			return;
		}

		navigation.cancel();
	});

	$effect(() => {
		const sessionId = sessionMatch?.[1];
		let cancelled = false;
		let subscription: SubscriptionLike | null = null;

		sessionTimer = null;

		if (!sessionId || isCheckingAuth || Boolean(authError)) {
			return;
		}

		const activeSessionId = sessionId;

		void (async () => {
			try {
				const api = (await import('$lib/db')) as DatabaseApi;

				async function loadTimer() {
					const timer = await api.getSessionTimerSummary(activeSessionId);

					if (!cancelled) {
						sessionTimer = timer;
					}
				}

				await loadTimer();
				void api
					.hydrateVisibleScope({ type: 'session', sessionId: activeSessionId })
					.catch(() => undefined);

				if (!cancelled) {
					subscription = api.subscribeToDatabaseChanges(
						['workoutSessions', 'sessionExercises', 'sessionSets'],
						() => {
							void loadTimer();
						},
						{ debounceMs: 250 }
					);
				}
			} catch {
				if (!cancelled) {
					sessionTimer = null;
				}
			}
		})();

		return () => {
			cancelled = true;
			subscription?.unsubscribe();
		};
	});

	$effect(() => {
		const sessionId = sessionMatch?.[1];
		const timerSummary = isSessionOverviewPage ? $sessionOverviewActions?.timerSummary : null;

		if (timerSummary && timerSummary.id === sessionId) {
			sessionTimer = timerSummary;
		}
	});

	$effect(() => {
		const sessionId = sessionMatch?.[1];
		sessionEditDraft = sessionId && isSessionEditRoute ? readSessionEditDraft(sessionId) : null;
	});

	$effect(() => {
		let intervalId: ReturnType<typeof setInterval> | null = null;

		if (showSessionTimer) {
			nowMs = Date.now();
			intervalId = setInterval(() => {
				nowMs = Date.now();
			}, 1000);
		}

		return () => {
			if (intervalId) {
				clearInterval(intervalId);
			}
		};
	});

	$effect(() => {
		if (!isSessionOverviewPage || !$sessionOverviewActions) {
			isSessionActionsMenuOpen = false;
		}
	});

	function runSessionAction(action: () => void | Promise<void>) {
		isSessionActionsMenuOpen = false;
		void action();
	}

	function goBack() {
		const targetPath = resolveParentPath(getParentPath(page.url.pathname));

		if (!confirmEditNavigation(targetPath)) {
			return;
		}

		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(targetPath);
	}

	function confirmEditNavigation(targetPath: string) {
		const sessionId = sessionMatch?.[1];

		if (
			!sessionId ||
			!isSessionEditRoute ||
			isSavingEditNavigation(new URL(targetPath, page.url))
		) {
			return true;
		}

		if (!window.confirm(SESSION_EDIT_DISCARD_MESSAGE)) {
			return false;
		}

		clearSessionEditDraft(sessionId);
		sessionEditDraft = null;

		return true;
	}

	function isSavingEditNavigation(targetUrl?: URL | null) {
		if (!targetUrl) {
			return false;
		}

		const sessionId = sessionMatch?.[1];

		return Boolean(
			sessionId &&
			targetUrl.pathname.startsWith(`/sessions/${sessionId}`) &&
			targetUrl.searchParams.get('edit') === '1'
		);
	}

	function getHomePath(dayKey?: string) {
		return dayKey && dayKey !== todayDayKey ? `/?date=${encodeURIComponent(dayKey)}` : '/';
	}

	function getDayKey(date: Date) {
		return [
			String(date.getFullYear()).padStart(4, '0'),
			String(date.getMonth() + 1).padStart(2, '0'),
			String(date.getDate()).padStart(2, '0')
		].join('-');
	}

	function resolveParentPath(path: string) {
		if (path.startsWith('/?')) {
			return `${resolve('/')}${path.slice(1)}`;
		}

		return resolve(path as '/' | '/workouts' | '/exercises' | `/sessions/${string}`);
	}

	function getParentPath(pathname: string): string {
		if (pathname === '/workouts' || pathname === '/exercises') {
			return getHomePath(page.url.searchParams.get('date') ?? undefined);
		}

		if (pathname === '/workouts/new') {
			return '/workouts';
		}

		const exerciseDetailMatch = pathname.match(/^\/exercises\/.+$/);

		if (exerciseDetailMatch) {
			return '/exercises';
		}

		const workoutDetailMatch = pathname.match(/^\/workouts\/[^/]+$/);

		if (workoutDetailMatch) {
			return '/workouts';
		}

		const sessionExerciseParentMatch = pathname.match(/^\/sessions\/([^/]+)\/exercises\/[^/]+$/);

		if (sessionExerciseParentMatch) {
			const parentPath = `/sessions/${sessionExerciseParentMatch[1]}`;

			return isSessionEditRoute ? `${parentPath}?edit=1` : parentPath;
		}

		const sessionParentMatch = pathname.match(/^\/sessions\/[^/]+$/);

		if (sessionParentMatch) {
			return getHomePath(displayedSessionTimer?.dayKey);
		}

		return getHomePath(page.url.searchParams.get('date') ?? undefined);
	}
</script>

<main
	class="relative mx-auto box-border flex h-svh max-h-svh w-full max-w-107.5 flex-col overflow-hidden bg-[#080b0d] px-4 py-4 text-zinc-100"
>
	{#if isCheckingAuth}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h1 class="mt-5 text-2xl font-semibold text-white">
				{isHandlingOAuthCallback ? 'Finishing sign-in' : 'Loading TinyTrain'}
			</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				{isHandlingOAuthCallback ? 'Connecting your Google account.' : 'Opening your workspace.'}
			</p>
		</section>
	{:else if authError}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Sign-in needs attention</h1>
			<p class="mt-3 text-sm leading-6 text-red-200">{authError}</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href={resolve('/login')}
			>
				Back to login
			</a>
			{#if callbackTimedOut}
				<p class="mt-3 text-sm leading-5 text-zinc-400">
					The OAuth callback reached the app, but the local database never finished starting.
				</p>
			{/if}
		</section>
	{:else}
		{#if !isHomePage}
			<header
				class="absolute inset-x-0 top-0 z-20 flex min-w-0 items-center gap-2 border-b border-white/[0.07] bg-[#080b0d]/35 px-4 pt-3.5 pb-3 shadow-[0_18px_36px_rgba(0,0,0,0.22)] backdrop-blur-3xl [backdrop-filter:blur(28px)_saturate(1.35)]"
			>
				<div class="flex min-w-0 flex-1 items-center gap-2">
					<button
						class="flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-zinc-300"
						type="button"
						onclick={goBack}
						aria-label="Go back"
					>
						<Icon name="arrow-left" class="h-4 w-4" />
					</button>

					{#if sessionMatch && displayedSessionTimer?.workoutNameSnapshot}
						<h1 class="min-w-0 truncate text-base font-semibold text-white">
							{displayedSessionTimer.workoutNameSnapshot}
						</h1>
					{/if}
				</div>

				<div class="flex shrink-0 items-center gap-2">
					{#if showSessionTimer}
						{#if $sessionOverviewActions?.isEditMode && $sessionOverviewActions.canEditTime}
							<button
								class="inline-flex min-h-10 items-center gap-2 rounded-full border border-emerald-300/40 bg-emerald-300/10 px-3 text-xs font-semibold text-emerald-100"
								type="button"
								aria-label="Edit session time"
								onclick={$sessionOverviewActions.onOpenTimeEditor}
							>
								<Icon name="clock-3" class="h-3.5 w-3.5 text-emerald-200" />
								{formatDuration(
									displayedSessionTimer?.startedAt,
									displayedSessionTimer?.completedAt,
									sessionTimerNowMs
								)}
							</button>
						{:else}
							<div
								class="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/4 px-3 text-xs font-semibold text-zinc-200"
							>
								<Icon name="clock-3" class="h-3.5 w-3.5 text-zinc-500" />
								{formatDuration(
									displayedSessionTimer?.startedAt,
									displayedSessionTimer?.completedAt,
									sessionTimerNowMs
								)}
							</div>
						{/if}
					{/if}
					{#if showSessionStatus && displayedSessionTimer}
						<div
							class={`inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/4 px-3 text-xs font-semibold ${
								displayedSessionTimer.status === 'completed'
									? 'text-emerald-200'
									: displayedSessionTimer.status === 'abandoned'
										? 'text-red-200'
										: 'text-zinc-200'
							}`}
						>
							<Icon
								name={displayedSessionTimer.status === 'completed' ? 'check-circle' : 'activity'}
								class={`h-3.5 w-3.5 ${
									displayedSessionTimer.status === 'completed'
										? 'text-emerald-300'
										: displayedSessionTimer.status === 'abandoned'
											? 'text-red-300'
											: 'text-zinc-500'
								}`}
							/>
							{formatSessionStatus(displayedSessionTimer.status)}
						</div>
					{/if}
					<ProfileMenu user={currentUser} />
				</div>
			</header>
		{/if}

		{#if isSessionOverviewPage && $sessionOverviewActions}
			<div class="pointer-events-none absolute top-20 right-4 z-30">
				<div class="pointer-events-auto relative" bind:this={sessionActionsMenuContainer}>
					<button
						class="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-[#11171a]/35 text-sm font-semibold text-zinc-300 shadow-[0_12px_30px_rgba(0,0,0,0.28)] backdrop-blur-3xl [backdrop-filter:blur(24px)_saturate(1.35)] disabled:text-zinc-500"
						type="button"
						title="Open session menu"
						aria-label="Open session menu"
						aria-expanded={isSessionActionsMenuOpen}
						disabled={$sessionOverviewActions.isSaving || $sessionOverviewActions.isSharingSession}
						onclick={() => (isSessionActionsMenuOpen = !isSessionActionsMenuOpen)}
					>
						···
					</button>

					{#if isSessionActionsMenuOpen}
						<div
							class="absolute top-12 right-0 z-30 grid min-w-44 gap-2 rounded-lg border border-white/10 bg-white/6 p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-3xl"
						>
							{#if $sessionOverviewActions.status === 'completed'}
								<button
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200 disabled:text-zinc-500"
									type="button"
									disabled={$sessionOverviewActions.isSaving ||
										$sessionOverviewActions.isSharingSession}
									onclick={() => runSessionAction($sessionOverviewActions!.onShareSession)}
								>
									<Icon name="share-2" class="h-4 w-4 text-emerald-200" />
									{$sessionOverviewActions.isSharingSession ? 'Rendering image' : 'Share session'}
								</button>
							{/if}

							{#if $sessionOverviewActions.isEditMode}
								<button
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-emerald-100 disabled:text-zinc-500"
									type="button"
									disabled={$sessionOverviewActions.isSaving}
									onclick={() => runSessionAction($sessionOverviewActions!.onSaveEditMode)}
								>
									<Icon name="check" class="h-4 w-4 text-emerald-200" />
									{$sessionOverviewActions.hasUnsavedChanges ? 'Save changes' : 'Done editing'}
								</button>
								<button
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-300 disabled:text-zinc-500"
									type="button"
									disabled={$sessionOverviewActions.isSaving}
									onclick={() => runSessionAction($sessionOverviewActions!.onDiscardEditMode)}
								>
									<Icon name="x" class="h-4 w-4 text-zinc-500" />
									Discard edit
								</button>
							{:else if $sessionOverviewActions.canEditSession}
								<button
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
									type="button"
									disabled={$sessionOverviewActions.isSaving}
									onclick={() => runSessionAction($sessionOverviewActions!.onEnterEditMode)}
								>
									<Icon name="pencil" class="h-4 w-4 text-zinc-400" />
									Edit session
								</button>
							{/if}

							{#if $sessionOverviewActions.status === 'in_progress'}
								<button
									class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
									type="button"
									disabled={$sessionOverviewActions.isSaving}
									onclick={() => runSessionAction($sessionOverviewActions!.onEndSession)}
								>
									End session
								</button>
								<button
									class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
									type="button"
									disabled={$sessionOverviewActions.isSaving}
									onclick={() => runSessionAction($sessionOverviewActions!.onResetSession)}
								>
									Reset session
								</button>
							{/if}

							<button
								class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-red-200"
								type="button"
								disabled={$sessionOverviewActions.isSaving}
								onclick={() => runSessionAction($sessionOverviewActions!.onDeleteSession)}
							>
								<Icon name="trash-2" class="h-4 w-4 text-red-300" />
								Delete session
							</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div
			class={`no-scrollbar flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pb-6 ${
				!isHomePage ? 'pt-14' : ''
			}`}
			data-app-scroll-area
		>
			{@render children()}
		</div>
	{/if}
</main>
