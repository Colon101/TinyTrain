type DialogFocusOptions = {
	onEscape?: () => void;
	initialFocus?: string;
};

const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])'
].join(',');

function getFocusableElements(node: HTMLElement) {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true'
	);
}

export function trapDialogFocus(node: HTMLElement, options: DialogFocusOptions = {}) {
	let currentOptions = options;
	const previousFocus =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;

	queueMicrotask(() => {
		if (!node.isConnected) {
			return;
		}

		const initialTarget = currentOptions.initialFocus
			? node.querySelector<HTMLElement>(currentOptions.initialFocus)
			: null;
		(initialTarget ?? getFocusableElements(node)[0] ?? node).focus();
	});

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && currentOptions.onEscape) {
			event.preventDefault();
			event.stopPropagation();
			currentOptions.onEscape();
			return;
		}

		if (event.key !== 'Tab') {
			return;
		}

		const focusableElements = getFocusableElements(node);

		if (focusableElements.length === 0) {
			event.preventDefault();
			node.focus();
			return;
		}

		const first = focusableElements[0];
		const last = focusableElements.at(-1)!;
		const activeElement = document.activeElement;

		if (event.shiftKey && (activeElement === first || !node.contains(activeElement))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (activeElement === last || !node.contains(activeElement))) {
			event.preventDefault();
			first.focus();
		}
	}

	node.addEventListener('keydown', handleKeydown);

	return {
		update(nextOptions: DialogFocusOptions = {}) {
			currentOptions = nextOptions;
		},
		destroy() {
			node.removeEventListener('keydown', handleKeydown);
			queueMicrotask(() => {
				if (previousFocus?.isConnected) {
					previousFocus.focus();
				}
			});
		}
	};
}
