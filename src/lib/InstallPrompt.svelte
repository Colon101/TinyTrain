<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	type InstallStatus = 'idle' | 'available' | 'installing' | 'installed' | 'manual';
	type InstallPlatform = 'generic' | 'ios' | 'android';

	let deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);
	let installPlatform = $state<InstallPlatform>('generic');
	let installStatus = $state<InstallStatus>('idle');
	let installMessage = $state('Save TinyTrain to your phone for quick access.');
	let showInstallSteps = $state(false);

	let installButtonText = $derived(
		installStatus === 'installing'
			? 'Opening install prompt...'
			: installStatus === 'installed'
				? 'Added to home screen'
				: installPlatform === 'ios'
					? 'Install on iPhone'
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
		showInstallSteps = false;
	}

	function showManualInstallHelp() {
		installStatus = 'manual';
		if (!window.isSecureContext) {
			installMessage =
				'Install needs an HTTPS address. The local network preview can open, but phones will not install it as an app.';
			showInstallSteps = false;
			return;
		}

		if (isIosDevice()) {
			installMessage = 'On iPhone or iPad, tap Share in Safari, then Add to Home Screen.';
			showInstallSteps = true;
			return;
		}

		installMessage = isAndroidDevice()
			? 'On Android, open Chrome menu, then tap Install app or Add to Home screen.'
			: 'Use your browser menu to install TinyTrain on this device.';
		showInstallSteps = true;
	}

	async function addToHomeScreen() {
		if (!browser) return;

		if (isStandalone()) {
			installStatus = 'installed';
			installMessage = 'TinyTrain is already installed on this device.';
			showInstallSteps = false;
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
			showInstallSteps = false;
			return;
		}

		showManualInstallHelp();
	}

	onMount(() => {
		if (isStandalone()) {
			installStatus = 'installed';
			installMessage = 'TinyTrain is already installed on this device.';
			showInstallSteps = false;
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
			showInstallSteps = false;
		};

		window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
		window.addEventListener('tinytraininstallprompt', handleStoredInstallPrompt);
		window.addEventListener('appinstalled', handleAppInstalled);

		if (!window.isSecureContext) {
			installStatus = 'manual';
			installMessage =
				'Install needs HTTPS. Open the deployed TinyTrain URL on your phone to add it as an app.';
		} else if (isIosDevice()) {
			installPlatform = 'ios';
			installStatus = 'manual';
			installMessage = 'Tap Install on iPhone for the Safari steps.';
		} else if (isAndroidDevice()) {
			installPlatform = 'android';
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

<section aria-label="Install TinyTrain">
	<button
		class="flex min-h-12 w-full items-center justify-center rounded-lg border border-accent/40 px-4 text-base font-semibold text-accent-subtle transition hover:border-accent-soft hover:bg-accent/10 disabled:cursor-default disabled:border-zinc-700 disabled:text-zinc-500 disabled:hover:bg-transparent"
		type="button"
		disabled={installStatus === 'installing' || installStatus === 'installed'}
		onclick={addToHomeScreen}
	>
		{installButtonText}
	</button>

	<p class="mt-3 min-h-10 text-sm leading-5 text-zinc-400" aria-live="polite">
		{installMessage}
	</p>

	{#if showInstallSteps}
		<section
			class="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm leading-5 text-zinc-300"
			aria-label="Install instructions"
		>
			<p class="font-semibold text-zinc-100">
				{installPlatform === 'ios'
					? 'Add TinyTrain from Safari'
					: 'Add TinyTrain from your browser'}
			</p>
			<ol class="mt-2 space-y-2">
				{#if installPlatform === 'ios'}
					<li>1. Open this page in Safari.</li>
					<li>2. Tap Share in the Safari toolbar. If you see More first, tap More, then Share.</li>
					<li>3. Choose Add to Home Screen.</li>
					<li>4. Keep Open as Web App on, then tap Add.</li>
					<li class="text-zinc-500">
						If Add to Home Screen is missing, scroll to the bottom of the Share sheet and tap Edit
						Actions.
					</li>
				{:else}
					<li>1. Open the browser menu.</li>
					<li>2. Choose Install app or Add to Home screen.</li>
					<li>3. Confirm the install.</li>
				{/if}
			</ol>
		</section>
	{/if}
</section>
