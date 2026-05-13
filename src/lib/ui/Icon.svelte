<script lang="ts">
	export type IconName =
		| 'activity'
		| 'arrow-left'
		| 'arrow-right'
		| 'check'
		| 'check-circle'
		| 'calendar'
		| 'chevron-left'
		| 'chevron-right'
		| 'clock-3'
		| 'database'
		| 'dumbbell'
		| 'grip-vertical'
		| 'history'
		| 'loader-circle'
		| 'log-out'
		| 'pencil'
		| 'plus'
		| 'refresh-cw'
		| 'rotate-ccw'
		| 'settings'
		| 'share-2'
		| 'shield-alert'
		| 'sparkles'
		| 'trash-2'
		| 'upload-cloud'
		| 'x';

	let {
		name,
		class: className = ''
	}: {
		name: IconName;
		class?: string;
	} = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	{#if name === 'activity'}
		<path d="M22 12h-4l-3 8-4-16-3 8H2" />
	{:else if name === 'arrow-left'}
		<path d="M19 12H5" />
		<path d="m12 19-7-7 7-7" />
	{:else if name === 'arrow-right'}
		<path d="M5 12h14" />
		<path d="m12 5 7 7-7 7" />
	{:else if name === 'check'}
		<path d="m20 6-11 11-5-5" />
	{:else if name === 'check-circle'}
		<circle cx="12" cy="12" r="10" />
		<path d="m9 12 2 2 4-4" />
	{:else if name === 'calendar'}
		<path d="M8 2v4" />
		<path d="M16 2v4" />
		<rect x="3" y="4" width="18" height="18" rx="2" />
		<path d="M3 10h18" />
	{:else if name === 'chevron-left'}
		<path d="m15 18-6-6 6-6" />
	{:else if name === 'chevron-right'}
		<path d="m9 18 6-6-6-6" />
	{:else if name === 'clock-3'}
		<circle cx="12" cy="12" r="10" />
		<path d="M12 6v6h4" />
	{:else if name === 'database'}
		<ellipse cx="12" cy="5" rx="8" ry="3" />
		<path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
		<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
	{:else if name === 'dumbbell'}
		<path d="M14.4 14.4 9.6 9.6" />
		<path d="M18.7 5.3a2 2 0 1 1 2.8 2.8l-1.4 1.4-2.8-2.8z" />
		<path d="M2.5 18.1a2 2 0 0 0 2.8 2.8l1.4-1.4-2.8-2.8z" />
		<path d="m9.6 14.4-4.3 4.3" />
		<path d="m14.4 9.6 4.3-4.3" />
		<path d="m7.5 12.3-1.8 1.8" />
		<path d="m16.5 11.7 1.8-1.8" />
		<path d="m6.9 18.9-1.8-1.8" />
		<path d="m19 6.9-1.8-1.8" />
	{:else if name === 'grip-vertical'}
		<circle cx="9" cy="5" r="1" />
		<circle cx="9" cy="12" r="1" />
		<circle cx="9" cy="19" r="1" />
		<circle cx="15" cy="5" r="1" />
		<circle cx="15" cy="12" r="1" />
		<circle cx="15" cy="19" r="1" />
	{:else if name === 'history'}
		<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
		<path d="M3 3v5h5" />
		<path d="M12 7v5l4 2" />
	{:else if name === 'loader-circle'}
		<path d="M21 12a9 9 0 1 1-6.2-8.6" />
	{:else if name === 'log-out'}
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<path d="m16 17 5-5-5-5" />
		<path d="M21 12H9" />
	{:else if name === 'pencil'}
		<path d="M12 20h9" />
		<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
	{:else if name === 'plus'}
		<path d="M12 5v14" />
		<path d="M5 12h14" />
	{:else if name === 'refresh-cw'}
		<path d="M21 12a9 9 0 0 0-15.5-6.4L3 8" />
		<path d="M3 3v5h5" />
		<path d="M3 12a9 9 0 0 0 15.5 6.4L21 16" />
		<path d="M16 16h5v5" />
	{:else if name === 'rotate-ccw'}
		<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
		<path d="M3 3v5h5" />
	{:else if name === 'settings'}
		<path
			fill="currentColor"
			fill-rule="evenodd"
			stroke="none"
			clip-rule="evenodd"
			d="M11.1 2.3c-.9 0-1.7.7-1.9 1.6L9 4.9c0 .1-.1.3-.3.3a7.5 7.5 0 0 0-1 .6c-.2.1-.3.1-.5.1l-1-.4a1.9 1.9 0 0 0-2.3.8L3 7.9a1.9 1.9 0 0 0 .4 2.4l.8.7c.1.1.2.2.2.4a7.6 7.6 0 0 0 0 1.1c0 .2-.1.4-.2.4l-.8.7A1.9 1.9 0 0 0 3 16.1l.9 1.6a1.9 1.9 0 0 0 2.3.8l1-.4c.1 0 .3 0 .5.1.3.2.6.4 1 .6.2.1.3.2.3.3l.2 1.1c.2.9.9 1.6 1.9 1.6h1.8c.9 0 1.7-.7 1.9-1.6l.2-1.1c0-.1.1-.3.3-.3.3-.2.7-.4 1-.6.2-.1.3-.1.5-.1l1 .4a1.9 1.9 0 0 0 2.3-.8l.9-1.6a1.9 1.9 0 0 0-.4-2.4l-.8-.7c-.1-.1-.2-.2-.2-.4a7.6 7.6 0 0 0 0-1.1c0-.2.1-.4.2-.4l.8-.7A1.9 1.9 0 0 0 21 7.9l-.9-1.6a1.9 1.9 0 0 0-2.3-.8l-1 .4c-.1 0-.3 0-.5-.1a7.5 7.5 0 0 0-1-.6c-.2-.1-.3-.2-.3-.3l-.2-1.1a1.9 1.9 0 0 0-1.9-1.6h-1.8ZM12 15.8a3.8 3.8 0 1 0 0-7.5 3.8 3.8 0 0 0 0 7.5Z"
		/>
	{:else if name === 'share-2'}
		<circle cx="18" cy="5" r="3" />
		<circle cx="6" cy="12" r="3" />
		<circle cx="18" cy="19" r="3" />
		<path d="m8.6 10.5 6.8-4" />
		<path d="m8.6 13.5 6.8 4" />
	{:else if name === 'shield-alert'}
		<path
			d="M20 13c0 5-3.5 7.5-7.6 8.9a1 1 0 0 1-.8 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"
		/>
		<path d="M12 8v4" />
		<path d="M12 16h.01" />
	{:else if name === 'sparkles'}
		<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z" />
		<path d="M5 3v4" />
		<path d="M3 5h4" />
		<path d="M19 17v4" />
		<path d="M17 19h4" />
	{:else if name === 'trash-2'}
		<path d="M3 6h18" />
		<path d="M8 6V4h8v2" />
		<path d="M19 6l-1 14H6L5 6" />
		<path d="M10 11v6" />
		<path d="M14 11v6" />
	{:else if name === 'upload-cloud'}
		<path d="M12 13v8" />
		<path d="m8 17 4-4 4 4" />
		<path d="M20.4 16.1A5 5 0 0 0 18 6h-1.3A8 8 0 1 0 4 15.3" />
		<path d="M16 16h1a4 4 0 0 0 0-8h-.3" />
	{:else if name === 'x'}
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	{/if}
</svg>
