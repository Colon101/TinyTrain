<script lang="ts">
	import {
		ACCENT_THEMES,
		accentThemeId,
		customAccentColor,
		saveAccentTheme,
		saveCustomAccentTheme,
		type AccentThemeId
	} from '$lib/accent-theme';
	import Icon from '$lib/ui/Icon.svelte';

	let preferenceErrorMessage = $state('');

	function selectAccentTheme(themeId: AccentThemeId) {
		preferenceErrorMessage = saveAccentTheme(themeId)
			? ''
			: 'The theme changed, but this browser could not save the preference.';
	}

	function selectCustomAccent(event: Event) {
		const color = (event.currentTarget as HTMLInputElement).value;
		preferenceErrorMessage = saveCustomAccentTheme(color)
			? ''
			: 'The theme changed, but this browser could not save the preference.';
	}
</script>

<fieldset class="grid gap-3">
	<legend class="mb-2 px-0.5 text-sm font-semibold text-white">Accent theme</legend>

	<div class="grid grid-cols-2 gap-2.5">
		{#each ACCENT_THEMES as theme (theme.id)}
			{@const previewAccent = theme.id === 'custom' ? $customAccentColor : theme.hex}
			<div
				class="relative min-w-0"
				style={`--preview-accent: ${previewAccent}; --preview-surface: var(--theme-preset-${theme.id}-surface);`}
			>
				<label class="block cursor-pointer">
					<input
						class="peer sr-only"
						type="radio"
						name="accent-theme"
						value={theme.id}
						checked={$accentThemeId === theme.id}
						onchange={() => selectAccentTheme(theme.id)}
					/>
					<span
						class={`grid min-h-28 gap-2.5 rounded-xl border p-3 transition duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-app ${
							$accentThemeId === theme.id
								? 'border-accent/70 bg-accent/10 shadow-lg shadow-accent-shadow/20'
								: 'border-white/10 bg-black/20 hover:border-white/25 hover:bg-white/[0.04]'
						}`}
					>
						<span class="theme-preview" aria-hidden="true">
							<span class="theme-preview__glow"></span>
							<span class="theme-preview__line theme-preview__line--long"></span>
							<span class="theme-preview__line theme-preview__line--short"></span>
							{#if theme.id !== 'custom'}
								<span class="theme-preview__button"></span>
							{/if}
						</span>

						<span class="min-w-0">
							<strong class="block truncate text-sm font-semibold text-white">{theme.name}</strong>
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

				{#if theme.id === 'custom'}
					<input
						class="custom-color-input"
						type="color"
						value={$customAccentColor}
						aria-label="Choose custom accent color"
						title="Choose custom accent color"
						oninput={selectCustomAccent}
					/>
				{/if}
			</div>
		{/each}
	</div>

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

	.custom-color-input {
		position: absolute;
		top: 2.2rem;
		right: 1.4rem;
		z-index: 20;
		width: 1.65rem;
		height: 1.15rem;
		cursor: pointer;
		border: 0;
		border-radius: 0.35rem;
		padding: 0;
		background: transparent;
		box-shadow: 0 0 1rem color-mix(in srgb, var(--preview-accent) 22%, transparent);
	}

	.custom-color-input:focus-visible {
		outline: 2px solid var(--preview-accent);
		outline-offset: 3px;
	}

	.custom-color-input::-webkit-color-swatch-wrapper {
		padding: 0;
	}

	.custom-color-input::-webkit-color-swatch {
		border: 0;
		border-radius: 0.35rem;
	}

	.custom-color-input::-moz-color-swatch {
		border: 0;
		border-radius: 0.35rem;
	}
</style>
