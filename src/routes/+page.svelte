<script lang="ts">
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';

	type InstallStatus = 'idle' | 'available' | 'installing' | 'installed' | 'manual';

	let deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);
	let installStatus = $state<InstallStatus>('idle');
	let installMessage = $state('Save TinyTrain to your phone for quick offline access.');

	let installButtonText = $derived(
		installStatus === 'installing'
			? 'Opening install prompt...'
			: installStatus === 'installed'
				? 'Added to home screen'
				: 'Add to home screen'
	);

	const isStandalone = () =>
		window.matchMedia('(display-mode: standalone)').matches ||
		('standalone' in navigator &&
			(navigator as Navigator & { standalone?: boolean }).standalone === true);

	const isIosDevice = () =>
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

	const isAndroidDevice = () => /Android/.test(navigator.userAgent);

	function setInstallPrompt(prompt: BeforeInstallPromptEvent) {
		deferredPrompt = prompt;
		installStatus = 'available';
		installMessage = 'TinyTrain is ready to install on this device.';
	}

	function showManualInstallHelp() {
		installStatus = 'manual';
		if (!window.isSecureContext) {
			installMessage =
				'Install needs an HTTPS address. The local network preview can open, but phones will not install it as an app.';
			return;
		}

		if (isIosDevice()) {
			installMessage = 'On iPhone or iPad, tap Share in Safari, then Add to Home Screen.';
			return;
		}

		installMessage = isAndroidDevice()
			? 'On Android, open Chrome menu, then tap Install app or Add to Home screen.'
			: 'Use your browser menu to install TinyTrain on this device.';
	}

	async function addToHomeScreen() {
		if (!browser) return;

		if (isStandalone()) {
			installStatus = 'installed';
			installMessage = 'TinyTrain is already installed on this device.';
			return;
		}

		if (!window.isSecureContext || isIosDevice()) {
			showManualInstallHelp();
			return;
		}

		deferredPrompt ??= window.__tinytrainInstallPrompt ?? null;

		if (!deferredPrompt) {
			showManualInstallHelp();
			return;
		}

		installStatus = 'installing';
		deferredPrompt.prompt();

		const choice = await deferredPrompt.userChoice;
		deferredPrompt = null;
		window.__tinytrainInstallPrompt = null;

		if (choice.outcome === 'accepted') {
			installStatus = 'installed';
			installMessage = 'TinyTrain is being added to your home screen.';
			return;
		}

		showManualInstallHelp();
	}

	onMount(() => {
		if (isStandalone()) {
			installStatus = 'installed';
			installMessage = 'TinyTrain is already installed on this device.';
			return;
		}

		const handleBeforeInstallPrompt = (event: Event) => {
			event.preventDefault();
			const prompt = event as BeforeInstallPromptEvent;
			window.__tinytrainInstallPrompt = prompt;
			setInstallPrompt(prompt);
		};

		const handleStoredInstallPrompt = () => {
			if (window.__tinytrainInstallPrompt) {
				setInstallPrompt(window.__tinytrainInstallPrompt);
			}
		};

		const handleAppInstalled = () => {
			deferredPrompt = null;
			window.__tinytrainInstallPrompt = null;
			installStatus = 'installed';
			installMessage = 'TinyTrain was added to your home screen.';
		};

		window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
		window.addEventListener('tinytraininstallprompt', handleStoredInstallPrompt);
		window.addEventListener('appinstalled', handleAppInstalled);

		if (!window.isSecureContext) {
			installStatus = 'manual';
			installMessage =
				'Install needs HTTPS. Open the deployed TinyTrain URL on your phone to add it as an app.';
		} else if (isIosDevice()) {
			installStatus = 'manual';
			installMessage = 'On iPhone or iPad, use Safari Share, then Add to Home Screen.';
		} else if (isAndroidDevice()) {
			installMessage =
				'On Android Chrome, the button opens the install prompt when the browser marks the app installable.';
		}

		handleStoredInstallPrompt();

		return () => {
			window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
			window.removeEventListener('tinytraininstallprompt', handleStoredInstallPrompt);
			window.removeEventListener('appinstalled', handleAppInstalled);
		};
	});
</script>

<main
	class="mx-auto flex min-h-svh w-full max-w-[430px] flex-col justify-center bg-[#080b0d] px-4 py-8 text-zinc-100"
>
	<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">TinyTrain</p>
	<h1 class="mt-2 text-3xl font-semibold text-white">Training log</h1>
	<p class="mt-2 text-sm leading-6 text-zinc-400">Build workouts and track your training.</p>

	<a
		class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
		href={resolve('/workouts')}
	>
		Open workouts
	</a>

	<button
		class="mt-3 flex min-h-12 items-center justify-center rounded-lg border border-emerald-300/40 px-4 text-base font-semibold text-emerald-100 transition hover:border-emerald-200 hover:bg-emerald-300/10 disabled:cursor-default disabled:border-zinc-700 disabled:text-zinc-500 disabled:hover:bg-transparent"
		type="button"
		disabled={installStatus === 'installing' || installStatus === 'installed'}
		onclick={addToHomeScreen}
	>
		{installButtonText}
	</button>

	<p class="mt-3 min-h-10 text-sm leading-5 text-zinc-400" aria-live="polite">
		{installMessage}
	</p>
</main>
