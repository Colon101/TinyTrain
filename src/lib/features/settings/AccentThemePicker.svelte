<script lang="ts">
	import {
		ACCENT_THEMES,
		accentThemeId,
		customAccentColor,
		saveAccentTheme,
		saveCustomAccentTheme,
		type AccentThemeId
	} from '$lib/accent-theme';

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

	<div class="grid gap-2">
		{#each ACCENT_THEMES as theme (theme.id)}
			{@const previewAccent = theme.id === 'custom' ? $customAccentColor : theme.hex}
			<div
				class={`flex min-h-12 items-center gap-3 rounded-lg border px-3 ${
					$accentThemeId === theme.id
						? 'border-accent/60 bg-accent/10'
						: 'border-white/10 bg-black/20'
				}`}
			>
				<label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
					<input
						class="h-4 w-4 shrink-0"
						type="radio"
						name="accent-theme"
						value={theme.id}
						checked={$accentThemeId === theme.id}
						onchange={() => selectAccentTheme(theme.id)}
					/>
					<span
						class="h-6 w-6 shrink-0 rounded-full border border-white/15"
						style={`background:${previewAccent}`}
						aria-hidden="true"
					></span>
					<strong class="truncate text-sm font-semibold text-white">{theme.name}</strong>
				</label>

				{#if theme.id === 'custom'}
					<input
						class="h-8 w-10 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
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
