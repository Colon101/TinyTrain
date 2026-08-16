<script lang="ts">
	import { onMount } from 'svelte';

	type InstallState = 'ready' | 'installing' | 'installed' | 'help';

	let deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);
	let installState = $state<InstallState>('ready');
	let isIos = $state(false);
	let isSecureContext = $state(true);

	let installButtonText = $derived(
		installState === 'installing'
			? 'Opening install prompt...'
			: installState === 'installed'
				? 'Added to home screen'
				: isIos
					? 'Install on iPhone'
					: 'Add to home screen'
	);
	let installMessage = $derived(
		installState === 'installed'
			? 'TinyTrain is installed on this device.'
			: installState === 'installing'
				? 'Confirm the install in your browser.'
				: installState === 'help'
					? !isSecureContext
						? 'Open TinyTrain over HTTPS before installing it.'
						: isIos
							? 'In Safari, tap Share, then Add to Home Screen.'
							: 'Open your browser menu and choose Install app or Add to home screen.'
					: deferredPrompt
						? 'TinyTrain is ready to install on this device.'
						: 'Save TinyTrain to your phone for quick access.'
	);

	function isStandalone() {
		return (
			window.matchMedia('(display-mode: standalone)').matches ||
			('standalone' in navigator &&
				(navigator as Navigator & { standalone?: boolean }).standalone === true)
		);
	}

	async function addToHomeScreen() {
		if (installState === 'installed' || installState === 'installing') {
			return;
		}

		const prompt = deferredPrompt ?? window.__tinytrainInstallPrompt ?? null;

		if (!prompt || isIos || !isSecureContext) {
			installState = 'help';
			return;
		}

		installState = 'installing';

		try {
			await prompt.prompt();
			const choice = await prompt.userChoice;
			installState = choice.outcome === 'accepted' ? 'installed' : 'help';
		} catch {
			installState = 'help';
		} finally {
			deferredPrompt = null;
			window.__tinytrainInstallPrompt = null;
		}
	}

	onMount(() => {
		isIos =
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		isSecureContext = window.isSecureContext;
		deferredPrompt = window.__tinytrainInstallPrompt ?? null;

		if (isStandalone()) {
			installState = 'installed';
		}

		const updatePrompt = () => {
			deferredPrompt = window.__tinytrainInstallPrompt ?? null;

			if (deferredPrompt && installState === 'help') {
				installState = 'ready';
			}
		};
		const markInstalled = () => {
			deferredPrompt = null;
			window.__tinytrainInstallPrompt = null;
			installState = 'installed';
		};

		window.addEventListener('tinytraininstallprompt', updatePrompt);
		window.addEventListener('appinstalled', markInstalled);

		return () => {
			window.removeEventListener('tinytraininstallprompt', updatePrompt);
			window.removeEventListener('appinstalled', markInstalled);
		};
	});
</script>

<section aria-label="Install TinyTrain">
	<button
		class="flex min-h-12 w-full items-center justify-center rounded-lg border border-accent/40 px-4 text-base font-semibold text-accent-subtle transition hover:border-accent-soft hover:bg-accent/10 disabled:cursor-default disabled:border-zinc-700 disabled:text-zinc-500 disabled:hover:bg-transparent"
		type="button"
		disabled={installState === 'installing' || installState === 'installed'}
		onclick={addToHomeScreen}
	>
		{installButtonText}
	</button>

	<p class="mt-3 min-h-10 text-sm leading-5 text-zinc-400" aria-live="polite">
		{installMessage}
	</p>
</section>
