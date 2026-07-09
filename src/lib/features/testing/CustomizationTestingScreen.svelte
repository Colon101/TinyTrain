<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';

	type DeltaPosition =
		| 'top-left'
		| 'top-center'
		| 'top-right'
		| 'bottom-left'
		| 'bottom-center'
		| 'bottom-right';
	type SetField = 'weight' | 'reps' | 'rar';
	type PreviewSet = Record<SetField, number> & { id: number };

	const POSITION_STORAGE_KEY = 'tinytrain-testing-delta-position';
	const DEFAULT_POSITION: DeltaPosition = 'bottom-left';
	const baseline: Record<SetField, number> = { weight: 100, reps: 5, rar: 2 };
	const positions: Array<{ value: DeltaPosition; label: string }> = [
		{ value: 'top-left', label: 'Top left' },
		{ value: 'top-center', label: 'Top center' },
		{ value: 'top-right', label: 'Top right' },
		{ value: 'bottom-left', label: 'Bottom left' },
		{ value: 'bottom-center', label: 'Bottom center' },
		{ value: 'bottom-right', label: 'Bottom right' }
	];
	const fields: Array<{ key: SetField; label: string; step: number }> = [
		{ key: 'weight', label: 'Weight', step: 2.5 },
		{ key: 'reps', label: 'Reps', step: 1 },
		{ key: 'rar', label: 'RAR', step: 1 }
	];

	let selectedPosition = $state<DeltaPosition>(DEFAULT_POSITION);
	let previewWidth = $state(420);
	let sets = $state<PreviewSet[]>(createSplitExample());

	let positionLabel = $derived(
		positions.find((position) => position.value === selectedPosition)?.label ?? 'Bottom left'
	);

	onMount(() => {
		const savedPosition = window.localStorage.getItem(POSITION_STORAGE_KEY);

		if (isDeltaPosition(savedPosition)) {
			selectedPosition = savedPosition;
		}
	});

	function isDeltaPosition(value: string | null): value is DeltaPosition {
		return positions.some((position) => position.value === value);
	}

	function createBaselineSets(): PreviewSet[] {
		return [1, 2, 3].map((id) => ({ id, ...baseline }));
	}

	function createSplitExample(): PreviewSet[] {
		return [
			{ id: 1, ...baseline },
			{ id: 2, weight: 105, reps: 6, rar: 3 },
			{ id: 3, weight: 95, reps: 4, rar: 1 }
		];
	}

	function selectPosition(position: DeltaPosition) {
		selectedPosition = position;
		window.localStorage.setItem(POSITION_STORAGE_KEY, position);
	}

	function updateSet(setId: number, field: SetField, event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		const nextValue = target.valueAsNumber;

		if (!Number.isFinite(nextValue)) {
			return;
		}

		sets = sets.map((set) => (set.id === setId ? { ...set, [field]: nextValue } : set));
	}

	function addSet() {
		const nextId = sets.reduce((highestId, set) => Math.max(highestId, set.id), 0) + 1;
		sets = [...sets, { id: nextId, ...baseline }];
	}

	function removeSet(setId: number) {
		sets = sets.filter((set) => set.id !== setId);
	}

	function getDelta(value: number, field: SetField) {
		return Number((value - baseline[field]).toFixed(2));
	}

	function formatDelta(delta: number) {
		if (delta === 0) {
			return '';
		}

		return `${delta > 0 ? '+' : ''}${delta}`;
	}

	function getDeltaState(delta: number) {
		if (delta > 0) {
			return 'positive';
		}

		if (delta < 0) {
			return 'negative';
		}

		return 'baseline';
	}
</script>

<svelte:head>
	<title>Input Customization Lab | TinyTrain</title>
	<meta
		name="description"
		content="TinyTrain development preview for positioning set comparison indicators."
	/>
</svelte:head>

<main class="customization-lab">
	<header class="lab-header">
		<div>
			<p class="eyebrow">TinyTrain testing</p>
			<h1>Input customization lab</h1>
			<p class="intro">
				Choose exactly where progress indicators sit inside Weight, Reps, and RAR inputs. This
				preview is isolated from live workout data.
			</p>
		</div>
		<div class="prototype-badge"><span></span> Interactive prototype</div>
	</header>

	<div class="lab-layout">
		<section class="preview-panel" aria-labelledby="preview-title">
			<div class="section-heading">
				<div>
					<p class="section-kicker">Live preview</p>
					<h2 id="preview-title">Barbell bench press</h2>
				</div>
				<p class="position-readout">Indicator: <strong>{positionLabel}</strong></p>
			</div>

			<div class="preview-stage">
				<div
					class="workout-preview"
					style={`--preview-width: ${previewWidth}px`}
					data-testid="workout-preview"
				>
					<div class="exercise-heading">
						<div>
							<p class="exercise-number">Exercise 1 of 4</p>
							<h3>Barbell bench press</h3>
						</div>
						<div class="set-count">{sets.length} {sets.length === 1 ? 'set' : 'sets'}</div>
					</div>

					<div class="baseline-note">
						<span>Comparison baseline</span>
						<strong>100 kg · 5 reps · 2 RAR</strong>
					</div>

					<div class="set-grid set-labels" aria-hidden="true">
						<span>Set</span>
						{#each fields as field (field.key)}
							<span>{field.label}</span>
						{/each}
						<span class="sr-only">Remove</span>
					</div>

					<div class="sets-list">
						{#each sets as set (set.id)}
							<div class="set-grid set-row">
								<div class="set-number">
									<span>Set</span>
									<strong>{String(set.id).padStart(2, '0')}</strong>
								</div>

								{#each fields as field (field.key)}
									{@const delta = getDelta(set[field.key], field.key)}
									<label
										class="set-input"
										data-delta-position={selectedPosition}
										data-delta-state={getDeltaState(delta)}
									>
										<span class="sr-only">Set {set.id} {field.label}</span>
										<input
											type="number"
											min="0"
											step={field.step}
											value={set[field.key]}
											oninput={(event) => updateSet(set.id, field.key, event)}
										/>
										<span
											class="delta-indicator"
											data-state={getDeltaState(delta)}
											data-testid={`delta-${set.id}-${field.key}`}
										>
											{formatDelta(delta)}
										</span>
									</label>
								{/each}

								<button
									class="remove-set"
									type="button"
									aria-label={`Remove set ${set.id}`}
									title="Remove set"
									onclick={() => removeSet(set.id)}
								>
									<Icon name="x" class="h-4 w-4" />
								</button>
							</div>
						{/each}
					</div>

					<button class="add-set" type="button" onclick={addSet}>
						<span>+</span> Add set
					</button>
				</div>
			</div>

			<div class="preview-actions" aria-label="Preview examples">
				<button type="button" onclick={() => (sets = createSplitExample())}>± Split example</button>
				<button type="button" onclick={() => (sets = createBaselineSets())}
					>Reset to baseline</button
				>
			</div>
			<p class="preview-help">
				Edit any value to test larger positive or negative differences. Green is above the baseline;
				red is below it.
			</p>
		</section>

		<aside class="appearance-panel" aria-labelledby="appearance-title">
			<div class="appearance-heading">
				<div class="appearance-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
						<circle cx="12" cy="12" r="3"></circle>
						<path
							d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
						></path>
					</svg>
				</div>
				<div>
					<p class="section-kicker">Settings</p>
					<h2 id="appearance-title">Appearance</h2>
				</div>
			</div>

			<div class="setting-block">
				<div class="setting-label">
					<div>
						<h3>Progress indicator position</h3>
						<p>Applied to Weight, Reps, and RAR.</p>
					</div>
					<span>{positionLabel}</span>
				</div>

				<div class="position-picker">
					{#each positions as position (position.value)}
						<button
							class:selected={selectedPosition === position.value}
							class:top={position.value.startsWith('top')}
							class:bottom={position.value.startsWith('bottom')}
							class:left={position.value.endsWith('left')}
							class:center={position.value.endsWith('center')}
							class:right={position.value.endsWith('right')}
							type="button"
							data-position={position.value}
							aria-pressed={selectedPosition === position.value}
							onclick={() => selectPosition(position.value)}
						>
							<span class="position-choice-heading">
								<span>{position.label}</span>
								{#if selectedPosition === position.value}
									<svg class="selection-check" viewBox="0 0 20 20" aria-hidden="true">
										<path
											d="m5 10 3 3 7-7"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										></path>
									</svg>
								{/if}
							</span>
							<span class="position-example" data-example-position={position.value}>
								<strong>10</strong>
								<span class="position-example-delta">+10</span>
							</span>
						</button>
					{/each}
				</div>

				<p class="saved-note"><span>✓</span> Preference is saved in this browser.</p>
			</div>

			<div class="setting-block width-setting">
				<div class="setting-label">
					<div>
						<h3>Preview width</h3>
						<p>Shrink the card to check clipping.</p>
					</div>
					<output for="preview-width">{previewWidth}px</output>
				</div>
				<input
					id="preview-width"
					type="range"
					min="320"
					max="620"
					step="10"
					bind:value={previewWidth}
				/>
				<div class="range-labels"><span>Phone</span><span>Wide</span></div>
			</div>

			<div class="prototype-note">
				<strong>Prototype only</strong>
				<p>No workout records or production settings are changed on this route.</p>
			</div>
		</aside>
	</div>
</main>

<style>
	:global(body) {
		background:
			radial-gradient(circle at 16% 0%, rgba(52, 211, 153, 0.1), transparent 32rem), #070a0d;
	}

	.customization-lab {
		width: min(100%, 1240px);
		min-height: 100svh;
		margin: 0 auto;
		padding: 38px 28px 56px;
		color: #f4f4f5;
	}

	.lab-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 28px;
		margin-bottom: 28px;
	}

	.eyebrow,
	.section-kicker,
	.exercise-number {
		margin: 0;
		font-size: 11px;
		font-weight: 750;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #6ee7b7;
	}

	.lab-header h1 {
		margin: 7px 0 0;
		font-size: clamp(30px, 4vw, 44px);
		line-height: 1.05;
		letter-spacing: -0.035em;
	}

	.intro {
		max-width: 690px;
		margin: 12px 0 0;
		font-size: 15px;
		line-height: 1.65;
		color: #a1a1aa;
	}

	.prototype-badge {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		flex: 0 0 auto;
		margin-top: 4px;
		padding: 9px 12px;
		border: 1px solid rgba(110, 231, 183, 0.24);
		border-radius: 999px;
		background: rgba(16, 185, 129, 0.08);
		font-size: 12px;
		font-weight: 700;
		color: #d1fae5;
	}

	.prototype-badge span {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #6ee7b7;
		box-shadow: 0 0 0 4px rgba(110, 231, 183, 0.12);
	}

	.lab-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 360px;
		gap: 22px;
		align-items: start;
	}

	.preview-panel,
	.appearance-panel {
		min-width: 0;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 20px;
		background: rgba(14, 19, 22, 0.88);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.24);
	}

	.preview-panel {
		padding: 22px;
	}

	.section-heading,
	.appearance-heading,
	.setting-label,
	.exercise-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.section-kicker {
		color: #71717a;
	}

	.section-heading h2,
	.appearance-heading h2 {
		margin: 5px 0 0;
		font-size: 21px;
		letter-spacing: -0.02em;
	}

	.position-readout {
		margin: 0;
		padding: 8px 10px;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.05);
		font-size: 12px;
		color: #a1a1aa;
	}

	.position-readout strong {
		color: #f4f4f5;
	}

	.preview-stage {
		display: grid;
		place-items: start center;
		min-width: 0;
		margin-top: 18px;
		padding: 22px;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.07);
		border-radius: 14px;
		background:
			linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
			linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px), #090c0f;
		background-size: 20px 20px;
	}

	.workout-preview {
		width: min(100%, var(--preview-width));
		min-width: 0;
		padding: 16px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 14px;
		background: #080b0d;
		box-shadow: 0 18px 55px rgba(0, 0, 0, 0.38);
		transition: width 160ms ease;
	}

	.exercise-number {
		font-size: 9px;
		color: #71717a;
	}

	.exercise-heading h3 {
		margin: 4px 0 0;
		font-size: 17px;
		letter-spacing: -0.015em;
	}

	.set-count {
		flex: 0 0 auto;
		padding: 5px 8px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		font-size: 10px;
		font-weight: 700;
		color: #a1a1aa;
	}

	.baseline-note {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 14px;
		padding: 9px 10px;
		border: 1px solid rgba(110, 231, 183, 0.13);
		border-radius: 8px;
		background: rgba(16, 185, 129, 0.055);
		font-size: 10px;
		color: #71717a;
	}

	.baseline-note strong {
		white-space: nowrap;
		color: #d1fae5;
	}

	.set-grid {
		display: grid;
		grid-template-columns: 42px repeat(3, minmax(0, 1fr)) 28px;
		gap: 6px;
		min-width: 0;
	}

	.set-labels {
		margin-top: 14px;
		padding: 0 7px;
		font-size: 9px;
		font-weight: 750;
		letter-spacing: 0.12em;
		text-align: center;
		text-transform: uppercase;
		color: #71717a;
	}

	.set-labels span:first-child {
		text-align: left;
	}

	.sets-list {
		display: grid;
		gap: 6px;
		margin-top: 6px;
	}

	.set-row {
		align-items: center;
		padding: 6px;
		border: 1px solid rgba(255, 255, 255, 0.11);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.025);
	}

	.set-number {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-width: 0;
	}

	.set-number span {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.13em;
		text-transform: uppercase;
		color: #52525b;
	}

	.set-number strong {
		margin-top: 3px;
		font-size: 18px;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.set-input {
		position: relative;
		display: block;
		min-width: 0;
		height: 44px;
	}

	.set-input input {
		width: 100%;
		height: 100%;
		min-width: 0;
		border: 2px solid #d4d4d8;
		border-radius: 6px;
		background: #fafafa;
		font-size: 17px;
		font-weight: 750;
		line-height: 1;
		text-align: center;
		font-variant-numeric: tabular-nums;
		color: #09090b;
		outline: none;
		appearance: textfield;
		-moz-appearance: textfield;
		padding: 0 5px;
	}

	.set-input[data-delta-state='positive'] input {
		border-color: #10b981;
	}

	.set-input[data-delta-state='negative'] input {
		border-color: #ef4444;
	}

	.set-input input::-webkit-inner-spin-button,
	.set-input input::-webkit-outer-spin-button {
		margin: 0;
		-webkit-appearance: none;
	}

	.set-input input:focus {
		border-color: #6ee7b7;
		box-shadow: 0 0 0 2px rgba(110, 231, 183, 0.18);
	}

	.delta-indicator {
		position: absolute;
		z-index: 1;
		display: block;
		max-width: calc(100% - 12px);
		overflow: hidden;
		font-size: 9px;
		font-weight: 800;
		line-height: 1;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}

	.delta-indicator[data-state='positive'] {
		color: #047857;
	}

	.delta-indicator[data-state='negative'] {
		color: #b91c1c;
	}

	.delta-indicator[data-state='baseline'] {
		color: #71717a;
	}

	.set-input[data-delta-position^='top'] .delta-indicator {
		top: 4px;
	}

	.set-input[data-delta-position^='bottom'] .delta-indicator {
		bottom: 4px;
	}

	.set-input[data-delta-position$='left'] .delta-indicator {
		left: 6px;
		text-align: left;
	}

	.set-input[data-delta-position$='center'] .delta-indicator {
		left: 50%;
		transform: translateX(-50%);
		text-align: center;
	}

	.set-input[data-delta-position$='right'] .delta-indicator {
		right: 6px;
		text-align: right;
	}

	.remove-set {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #a1a1aa;
		cursor: pointer;
		transition:
			background 120ms ease,
			color 120ms ease;
	}

	.remove-set:hover {
		background: rgba(248, 113, 113, 0.1);
		color: #fee2e2;
	}

	.add-set {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		width: 100%;
		min-height: 38px;
		margin-top: 8px;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.035);
		font-size: 11px;
		font-weight: 700;
		color: #e4e4e7;
		cursor: pointer;
	}

	.add-set span {
		font-size: 16px;
		color: #6ee7b7;
	}

	.preview-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 15px;
	}

	.preview-actions button {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.04);
		font-size: 12px;
		font-weight: 700;
		color: #d4d4d8;
		cursor: pointer;
	}

	.preview-actions button:hover,
	.add-set:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.preview-help {
		margin: 11px 0 0;
		font-size: 11px;
		line-height: 1.55;
		color: #71717a;
	}

	.appearance-panel {
		position: sticky;
		top: 22px;
		padding: 20px;
	}

	.appearance-heading {
		align-items: center;
		justify-content: flex-start;
	}

	.appearance-icon {
		display: grid;
		place-items: center;
		width: 42px;
		height: 42px;
		border: 1px solid rgba(110, 231, 183, 0.2);
		border-radius: 11px;
		background: rgba(16, 185, 129, 0.08);
		color: #a7f3d0;
	}

	.appearance-icon svg {
		width: 21px;
		height: 21px;
	}

	.setting-block {
		margin-top: 20px;
		padding-top: 19px;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	.setting-label h3 {
		margin: 0;
		font-size: 13px;
		font-weight: 720;
	}

	.setting-label p {
		margin: 5px 0 0;
		font-size: 11px;
		line-height: 1.45;
		color: #71717a;
	}

	.setting-label > span,
	.setting-label output {
		flex: 0 0 auto;
		font-size: 11px;
		font-weight: 700;
		color: #a7f3d0;
	}

	.position-picker {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		margin-top: 10px;
	}

	.position-picker button {
		position: relative;
		display: grid;
		grid-template-rows: auto 48px;
		gap: 2px;
		min-width: 0;
		padding: 3px;
		border: 2px solid rgba(255, 255, 255, 0.16);
		border-radius: 8px;
		background: #11171a;
		font-size: 10px;
		font-weight: 750;
		color: #d4d4d8;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background 120ms ease,
			color 120ms ease;
	}

	.position-picker button:hover {
		border-color: rgba(255, 255, 255, 0.3);
		background: #151c20;
		color: #ffffff;
	}

	.position-picker button.selected {
		border-color: #6ee7b7;
		background: rgba(16, 185, 129, 0.08);
		box-shadow: 0 0 0 1px rgba(110, 231, 183, 0.08);
		color: #d1fae5;
	}

	.position-choice-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		min-width: 0;
		line-height: 1;
	}

	.position-choice-heading > span {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.position-example {
		position: relative;
		display: block;
		min-width: 0;
		overflow: hidden;
		border: 2px solid #10b981;
		border-radius: 6px;
		background: #fafafa;
		color: #09090b;
	}

	.position-example strong {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-size: 16px;
		font-weight: 800;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.position-example-delta {
		position: absolute;
		z-index: 1;
		max-width: calc(100% - 12px);
		overflow: hidden;
		font-size: 9px;
		font-weight: 850;
		line-height: 1;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-variant-numeric: tabular-nums;
		color: #047857;
	}

	.position-example[data-example-position^='top'] .position-example-delta {
		top: 4px;
	}

	.position-example[data-example-position^='bottom'] .position-example-delta {
		bottom: 4px;
	}

	.position-example[data-example-position$='left'] .position-example-delta {
		left: 6px;
		text-align: left;
	}

	.position-example[data-example-position$='center'] .position-example-delta {
		left: 50%;
		transform: translateX(-50%);
		text-align: center;
	}

	.position-example[data-example-position$='right'] .position-example-delta {
		right: 6px;
		text-align: right;
	}

	.selection-check {
		width: 10px;
		height: 10px;
		padding: 1px;
		flex: 0 0 auto;
		border-radius: 50%;
		background: #6ee7b7;
		color: #052e22;
	}

	.saved-note {
		margin: 11px 0 0;
		font-size: 10px;
		color: #71717a;
	}

	.saved-note span {
		margin-right: 4px;
		color: #6ee7b7;
	}

	.width-setting input[type='range'] {
		width: 100%;
		margin-top: 15px;
		accent-color: #6ee7b7;
	}

	.range-labels {
		display: flex;
		justify-content: space-between;
		margin-top: 1px;
		font-size: 9px;
		color: #52525b;
	}

	.prototype-note {
		margin-top: 18px;
		padding: 12px;
		border: 1px solid rgba(251, 191, 36, 0.14);
		border-radius: 9px;
		background: rgba(251, 191, 36, 0.045);
		font-size: 11px;
		color: #fde68a;
	}

	.prototype-note p {
		margin: 4px 0 0;
		line-height: 1.45;
		color: #a1a1aa;
	}

	@media (max-width: 900px) {
		.customization-lab {
			padding: 28px 18px 44px;
		}

		.lab-layout {
			grid-template-columns: 1fr;
		}

		.appearance-panel {
			position: static;
		}
	}

	@media (max-width: 560px) {
		.customization-lab {
			padding: 20px 12px 36px;
		}

		.lab-header {
			flex-direction: column;
			gap: 14px;
		}

		.preview-panel,
		.appearance-panel {
			padding: 14px;
			border-radius: 15px;
		}

		.section-heading {
			align-items: flex-start;
			flex-direction: column;
			gap: 9px;
		}

		.preview-stage {
			padding: 10px;
		}

		.workout-preview {
			padding: 12px;
		}

		.baseline-note {
			align-items: flex-start;
			flex-direction: column;
			gap: 4px;
		}
	}
</style>
