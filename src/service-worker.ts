// Disables access to DOM typings like `HTMLElement` which are not available
// inside a service worker and instantiates the correct globals
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Ensures that the `$service-worker` import has proper type definitions
/// <reference types="@sveltejs/kit" />

// Only necessary if you have an import from `$env/static/public`
/// <reference types="../.svelte-kit/ambient.d.ts" />

import { build, files, version } from '$service-worker';

// This gives `self` the correct types
const self = globalThis.self as unknown as ServiceWorkerGlobalScope;

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;
const APP_SHELL = '/';
const DEPLOYMENT_MANIFEST = '/deployment.json';
const DEV = import.meta.env.DEV;
const LOG_PREFIX = '[TinyTrain service worker]';
const CACHE_UPDATE_MESSAGE = 'TINYTRAIN_CACHE_UPDATE_CHECK';
const DEPLOYMENT_CHECK_TTL_MS = 60_000;
// Keep this list synchronized with `authCacheParamNames` in src/app.html. That inline script
// is not bundled with this module, so the compiler cannot enforce that they match.
const AUTH_CACHE_PARAM_NAMES = [
	'code',
	'state',
	'error',
	'error_description',
	'access_token',
	'refresh_token',
	'provider_token',
	'provider_refresh_token'
];

const ASSETS = [
	...build, // the app itself
	...files, // everything in `static`
	APP_SHELL
];
const CACHEABLE_ASSET_PATHS = new Set(
	ASSETS.map((asset) => new URL(asset, self.location.origin).pathname)
);

type DeploymentManifest = {
	id?: unknown;
};

type CacheUrlsMessage = {
	type?: unknown;
	urls?: unknown;
};

type CacheUpdateMessage = {
	type: typeof CACHE_UPDATE_MESSAGE;
	status: 'checking' | 'current' | 'newer' | 'failed' | 'precache-skipped';
	cachedId?: string;
	latestId?: string;
	error?: string;
	failedAssets?: string[];
};

type DeploymentCheck = {
	promise: Promise<boolean>;
	expiresAt: number;
};

let currentDeploymentCheck: DeploymentCheck | undefined;
let lastCacheUpdateMessage: CacheUpdateMessage | undefined;

async function fetchFresh(request: Request | string) {
	const response = await fetch(request, { cache: 'no-store' });

	// if we're offline, fetch can return a value that is not a Response
	// instead of throwing - and we can't pass this non-Response to respondWith
	if (!(response instanceof Response)) {
		throw new Error('invalid response from fetch');
	}

	return response;
}

async function getCachedResponse(
	cache: Cache,
	request: Request,
	url: URL,
	options: { appShellFallback?: boolean } = {}
) {
	return (
		(await cache.match(request)) ??
		(await cache.match(url.pathname)) ??
		(options.appShellFallback && request.mode === 'navigate'
			? await cache.match(APP_SHELL)
			: undefined)
	);
}

async function readDeploymentId(response: Response | undefined) {
	if (!response?.ok) return undefined;

	try {
		const manifest = (await response.clone().json()) as DeploymentManifest;
		return typeof manifest.id === 'string' ? manifest.id : undefined;
	} catch {
		return undefined;
	}
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function announceCacheUpdate(message: Omit<CacheUpdateMessage, 'type'>) {
	const cacheUpdateMessage = { type: CACHE_UPDATE_MESSAGE, ...message };
	lastCacheUpdateMessage = cacheUpdateMessage;

	console.info(`${LOG_PREFIX} ${message.status}`, message);

	return self.clients
		.matchAll({ includeUncontrolled: true, type: 'window' })
		.then((clients) => {
			for (const client of clients) {
				client.postMessage(cacheUpdateMessage);
			}
		})
		.catch(() => undefined);
}

function hasAuthCacheParams(url: URL) {
	for (const paramName of AUTH_CACHE_PARAM_NAMES) {
		if (url.searchParams.has(paramName)) {
			return true;
		}
	}

	return false;
}

function isSafeSameOriginUrl(url: URL) {
	return url.origin === self.location.origin && !hasAuthCacheParams(url);
}

function canUseOfflineCache(request: Request, url: URL) {
	return (
		isSafeSameOriginUrl(url) &&
		(request.mode === 'navigate' || CACHEABLE_ASSET_PATHS.has(url.pathname))
	);
}

function canStoreResponse(request: Request, response: Response) {
	if (
		request.mode === 'navigate' ||
		request.headers.has('authorization') ||
		response.status !== 200
	) {
		return false;
	}

	const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';

	return !cacheControl.includes('no-store') && !cacheControl.includes('private');
}

async function hasCurrentDeployment(cache: Cache) {
	announceCacheUpdate({ status: 'checking' });

	const [cachedResponse, latestResponse] = await Promise.all([
		cache.match(DEPLOYMENT_MANIFEST),
		fetchFresh(`${DEPLOYMENT_MANIFEST}?sw-update=${Date.now()}`)
	]);

	const cachedId = await readDeploymentId(cachedResponse);
	const latestId = await readDeploymentId(latestResponse);

	const hasCurrentDeployment = Boolean(cachedId && latestId && cachedId === latestId);

	announceCacheUpdate({
		status: hasCurrentDeployment ? 'current' : 'newer',
		cachedId,
		latestId
	});

	return hasCurrentDeployment;
}

function hasVerifiedCurrentDeployment(cache: Cache) {
	if (!currentDeploymentCheck || Date.now() >= currentDeploymentCheck.expiresAt) {
		const nextCheck: DeploymentCheck = {
			promise: Promise.resolve(true),
			expiresAt: Number.POSITIVE_INFINITY
		};
		nextCheck.promise = hasCurrentDeployment(cache)
			.catch((error: unknown) => {
				announceCacheUpdate({
					status: 'failed',
					error: getErrorMessage(error)
				});

				return true;
			})
			.finally(() => {
				nextCheck.expiresAt = Date.now() + DEPLOYMENT_CHECK_TTL_MS;
			});
		currentDeploymentCheck = nextCheck;
	}

	return currentDeploymentCheck.promise;
}

function cacheResponse(event: FetchEvent, cache: Cache, request: Request, response: Response) {
	if (
		CACHEABLE_ASSET_PATHS.has(new URL(request.url).pathname) &&
		canStoreResponse(request, response)
	) {
		event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
	}
}

async function cacheUrls(urls: unknown) {
	if (!Array.isArray(urls)) {
		return;
	}

	const cache = await caches.open(CACHE);

	await Promise.all(
		urls.map(async (url) => {
			if (typeof url !== 'string') {
				return;
			}

			try {
				const parsedUrl = new URL(url, self.location.origin);

				if (!isSafeSameOriginUrl(parsedUrl) || !CACHEABLE_ASSET_PATHS.has(parsedUrl.pathname)) {
					return;
				}

				const response = await fetchFresh(parsedUrl.href);

				if (response.status === 200) {
					await cache.put(parsedUrl.href, response);
				}
			} catch {
				// Best-effort cache warming only.
			}
		})
	);
}

async function addFilesToCache(cache: Cache) {
	const results = await Promise.allSettled(
		ASSETS.map(async (asset) => {
			await cache.add(asset);
			return asset;
		})
	);

	const failedAssets = results
		.map((result, index) => (result.status === 'rejected' ? ASSETS[index] : undefined))
		.filter((asset): asset is string => Boolean(asset));

	if (failedAssets.length > 0) {
		await announceCacheUpdate({
			status: 'precache-skipped',
			failedAssets
		});

		throw new Error(`Unable to precache ${failedAssets.length} required asset(s).`);
	}
}

self.addEventListener('install', (event) => {
	// Create a new cache and add all files to it
	async function installCache() {
		if (DEV) {
			await self.skipWaiting();
			return;
		}

		const cache = await caches.open(CACHE);
		await addFilesToCache(cache);
	}

	event.waitUntil(installCache());
});

self.addEventListener('activate', (event) => {
	// Remove previous cached data from disk
	async function deleteOldCaches() {
		for (const key of await caches.keys()) {
			if (DEV || key !== CACHE) await caches.delete(key);
		}

		if (DEV) {
			await self.clients.claim();
		}
	}

	event.waitUntil(deleteOldCaches());
});

self.addEventListener('message', (event) => {
	const data = event.data as CacheUrlsMessage;

	if (data?.type === 'CACHE_URLS') {
		event.waitUntil(cacheUrls(data.urls));
	}

	if (data?.type === 'GET_CACHE_UPDATE_STATUS' && lastCacheUpdateMessage) {
		event.source?.postMessage(lastCacheUpdateMessage);
	}
});

self.addEventListener('fetch', (event) => {
	// ignore POST requests etc
	if (event.request.method !== 'GET') return;

	async function respond() {
		const url = new URL(event.request.url);
		const isSameOrigin = url.origin === self.location.origin;
		const isCacheableSameOrigin = isSameOrigin && canUseOfflineCache(event.request, url);
		const cache = await caches.open(CACHE);

		if (DEV) {
			try {
				const response = await fetchFresh(event.request);

				if (isCacheableSameOrigin) {
					cacheResponse(event, cache, event.request, response);
				}

				return response;
			} catch (err) {
				if (isCacheableSameOrigin) {
					const response = await getCachedResponse(cache, event.request, url, {
						appShellFallback: true
					});

					if (response) {
						return response;
					}
				}

				throw err;
			}
		}

		if (!isSameOrigin) {
			return fetch(event.request);
		}

		if (!isCacheableSameOrigin) {
			return fetchFresh(event.request);
		}

		if (url.pathname === DEPLOYMENT_MANIFEST) {
			return fetchFresh(event.request);
		}

		const cached = await getCachedResponse(cache, event.request, url);

		if (cached) {
			event.waitUntil(hasVerifiedCurrentDeployment(cache).catch(() => true));
			return cached;
		}

		try {
			const response = await fetchFresh(event.request);

			cacheResponse(event, cache, event.request, response);
			return response;
		} catch (err) {
			const response = await getCachedResponse(cache, event.request, url, {
				appShellFallback: true
			});

			if (response) {
				return response;
			}

			// if there's no cache, then just error out
			// as there is nothing we can do to respond to this request
			throw err;
		}
	}

	event.respondWith(respond());
});
