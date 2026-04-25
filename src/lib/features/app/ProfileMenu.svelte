<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type { CloudUser } from './user';
	import { getUserAvatarUrl, getUserDisplayName, getUserInitials } from './user';

	type DatabaseApi = typeof import('$lib/db');

	let { user }: { user: CloudUser } = $props();

	let api = $state<DatabaseApi | null>(null);
	let isOpen = $state(false);
	let isBusy = $state(false);
	let actionMessage = $state('');
	let actionError = $state('');
	let container = $state<HTMLElement | null>(null);

	let avatarUrl = $derived(getUserAvatarUrl(user));
	let displayName = $derived(getUserDisplayName(user));
	let initials = $derived(getUserInitials(user));

	onMount(() => {
		function handlePointerDown(event: PointerEvent) {
			const target = event.target as Node | null;

			if (container && target && !container.contains(target)) {
				isOpen = false;
			}
		}

		window.addEventListener('pointerdown', handlePointerDown);

		void (async () => {
			api = await import('$lib/db');
		})();

		return () => {
			window.removeEventListener('pointerdown', handlePointerDown);
		};
	});

	async function runAction(action: (dbApi: DatabaseApi) => Promise<void>) {
		if (!api) {
			actionError = 'Account tools are still loading. Try again in a moment.';
			return;
		}

		isBusy = true;
		actionMessage = '';
		actionError = '';

		try {
			await api.ensureDbOpen();
			await action(api);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			isBusy = false;
		}
	}

	function syncNow() {
		void runAction(async (dbApi) => {
			await dbApi.syncNow();
			window.location.reload();
		});
	}

	function signOut() {
		void runAction(async (dbApi) => {
			await dbApi.logoutFromCloud();
			isOpen = false;
		});
	}
</script>

<div class="relative" bind:this={container}>
	<button
		class="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] text-sm font-semibold text-white transition hover:border-emerald-300/50 hover:bg-white/[0.1]"
		type="button"
		title="Open account menu"
		aria-expanded={isOpen}
		onclick={() => (isOpen = !isOpen)}
	>
		{#if avatarUrl}
			<img class="h-full w-full object-cover" src={avatarUrl} alt={displayName} />
		{:else}
			<span>{initials}</span>
		{/if}
	</button>

	{#if isOpen}
		<div
			class="absolute top-[calc(100%+0.75rem)] right-0 z-30 w-64 rounded-lg border border-white/10 bg-[#11171a] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
		>
			<div class="border-b border-white/10 px-3 py-3">
				<p class="truncate text-sm font-semibold text-white">{displayName}</p>
				{#if user.email}
					<p class="mt-1 truncate text-xs text-zinc-400">{user.email}</p>
				{/if}
			</div>

			<div class="pt-2">
				<button
					class="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] disabled:text-zinc-500"
					type="button"
					disabled={!api || isBusy}
					onclick={syncNow}
				>
					{#if isBusy}
						<Icon name="loader-circle" class="h-4 w-4 animate-spin" />
					{:else}
						<Icon name="refresh-cw" class="h-4 w-4" />
					{/if}
					<span>Sync now</span>
				</button>

				<button
					class="mt-1 flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] disabled:text-zinc-500"
					type="button"
					disabled={!api || isBusy}
					onclick={signOut}
				>
					<Icon name="log-out" class="h-4 w-4" />
					<span>Log out</span>
				</button>
			</div>

			{#if actionError || actionMessage}
				<p
					class={`px-3 pt-3 pb-1 text-xs leading-5 ${actionError ? 'text-red-200' : 'text-zinc-400'}`}
				>
					{actionError || actionMessage}
				</p>
			{/if}
		</div>
	{/if}
</div>
