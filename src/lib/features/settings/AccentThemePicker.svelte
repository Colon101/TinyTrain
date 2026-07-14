<script lang="ts">
	import {
		ACCENT_THEMES,
		accentThemeId,
		saveAccentTheme,
		type AccentThemeId
	} from '$lib/accent-theme';
	import Icon from '$lib/ui/Icon.svelte';

	let preferenceErrorMessage = $state('');
	let selectedTheme = $derived(
		ACCENT_THEMES.find((theme) => theme.id === $accentThemeId) ?? ACCENT_THEMES[0]
	);

	function selectAccentTheme(themeId: AccentThemeId) {
		preferenceErrorMessage = saveAccentTheme(themeId)
			? ''
			: 'The theme changed, but this browser could not save the preference.';
	}
</script>

<fieldset class="grid gap-3">
	<div class="grid gap-1">
		<legend class="text-sm font-semibold text-white">Accent theme</legend>
		<p class="text-xs leading-5 text-zinc-400">
			Choose the color used for primary actions, selections, highlights, and ambient tints.
		</p>
	</div>

	<div class="grid grid-cols-2 gap-2.5">
		{#each ACCENT_THEMES as theme, index (theme.id)}
			<label
				class={`relative min-w-0 cursor-pointer ${
					ACCENT_THEMES.length % 2 === 1 && index === ACCENT_THEMES.length - 1
						? 'col-span-2 w-[calc(50%-0.3125rem)] justify-self-center'
						: ''
				}`}
				style={`--preview-accent: ${theme.hex}; --preview-surface: var(--theme-preset-${theme.id}-surface);`}
			>
				<input
					class="peer sr-only"
					type="radio"
					name="accent-theme"
					value={theme.id}
					checked={$accentThemeId === theme.id}
					onchange={() => selectAccentTheme(theme.id)}
				/>
				<span
					class={`grid min-h-32 gap-2.5 rounded-xl border p-3 transition duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-app ${
						$accentThemeId === theme.id
							? 'border-accent/70 bg-accent/10 shadow-lg shadow-accent-shadow/20'
							: 'border-white/10 bg-black/20 hover:border-white/25 hover:bg-white/[0.04]'
					}`}
				>
					<span class="theme-preview" aria-hidden="true">
						<span class="theme-preview__glow"></span>
						<span class="theme-preview__line theme-preview__line--long"></span>
						<span class="theme-preview__line theme-preview__line--short"></span>
						<span class="theme-preview__button"></span>
					</span>

					<span class="min-w-0">
						<strong class="block truncate text-sm font-semibold text-white">{theme.name}</strong>
						<span class="mt-0.5 block truncate text-[10px] leading-4 text-zinc-500">
							{theme.description}
						</span>
					</span>
					{#if $accentThemeId === theme.id}
						<span
							class="absolute top-2.5 right-2.5 z-10 grid h-5 w-5 place-items-center rounded-full bg-accent text-on-accent shadow-md shadow-black/30"
							aria-hidden="true"
						>
							<Icon name="check" class="h-3 w-3" />
						</span>
					{/if}
				</span>
			</label>
		{/each}
	</div>

	<p class="text-xs leading-5 text-zinc-500" aria-live="polite">
		Current: <span class="font-semibold text-accent-soft">{selectedTheme.name}</span>
		<span aria-hidden="true"> · </span>
		<code class="font-mono text-[11px] text-zinc-400">{selectedTheme.hex}</code>
	</p>
	{#if preferenceErrorMessage}
		<p class="text-xs leading-5 text-red-200" role="alert">{preferenceErrorMessage}</p>
	{/if}
</fieldset>

<style>
	.theme-preview {
		position: relative;
		display: block;
		height: 3.25rem;
		overflow: hidden;
		border: 1px solid rgb(255 255 255 / 0.1);
		border-radius: 0.5rem;
		background: var(--preview-surface);
	}

	.theme-preview__glow {
		position: absolute;
		inset: -1.75rem auto auto -1.25rem;
		width: 5rem;
		height: 5rem;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--preview-accent) 22%, transparent);
		filter: blur(0.75rem);
	}

	.theme-preview__line {
		position: absolute;
		left: 0.75rem;
		height: 0.25rem;
		border-radius: 9999px;
		background: rgb(255 255 255 / 0.16);
	}

	.theme-preview__line--long {
		top: 1rem;
		width: 2.75rem;
	}

	.theme-preview__line--short {
		top: 1.75rem;
		width: 1.75rem;
		background: color-mix(in srgb, var(--preview-accent) 50%, transparent);
	}

	.theme-preview__button {
		position: absolute;
		right: 0.65rem;
		bottom: 0.65rem;
		width: 1.65rem;
		height: 1.15rem;
		border-radius: 0.35rem;
		background: var(--preview-accent);
		box-shadow: 0 0 1rem color-mix(in srgb, var(--preview-accent) 22%, transparent);
	}
</style>
