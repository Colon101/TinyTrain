export const APP_SHELL = '/';

export function getDeploymentCacheName(version: string) {
	return `cache-${version}`;
}

export async function getCachedResponse(
	cache: Pick<Cache, 'match'>,
	request: Request,
	url: URL,
	options: { useAppShellForNavigation?: boolean } = {}
) {
	// A controlling production worker must never combine navigation HTML from a newer
	// deployment with the assets and open database instances from its own deployment.
	// If this deployment's shell is unavailable, return no match so the caller can use
	// the network as a last resort instead of accepting another cached navigation entry.
	if (options.useAppShellForNavigation && request.mode === 'navigate') {
		return cache.match(APP_SHELL);
	}

	return (await cache.match(request)) ?? (await cache.match(url.pathname));
}
