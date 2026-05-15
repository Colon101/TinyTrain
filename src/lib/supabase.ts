import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { env } from '$env/dynamic/public';
import { createClient, type Session, type User } from '@supabase/supabase-js';

const supabaseUrl =
	env.PUBLIC_SUPABASE_URL ||
	import.meta.env.VITE_SUPABASE_URL ||
	'https://rcognfamskwirstxmdrh.supabase.co';
const supabaseAnonKey =
	env.PUBLIC_SUPABASE_ANON_KEY ||
	import.meta.env.VITE_SUPABASE_ANON_KEY ||
	'sb_publishable_xuOkk0llHzFGPxyrki0adQ_61SG53d6';
const postLoginReloadKey = 'tinytrain:supabase-post-login-reload';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
	auth: {
		persistSession: true,
		autoRefreshToken: true,
		detectSessionInUrl: true
	}
});

type PostgrestFilterPatchTarget = {
	__tinytrainReservedColumnPatch?: boolean;
	eq(column: string, value: unknown): unknown;
	is(column: string, value: boolean | null): unknown;
};

const reservedPostgrestFilterColumns = new Set(['order']);

function quoteReservedPostgrestFilterColumn(column: string) {
	return reservedPostgrestFilterColumns.has(column) ? `"${column}"` : column;
}

function patchReservedPostgrestFilterColumns() {
	const filterBuilderPrototype = Object.getPrototypeOf(
		supabase.from('__tinytrain_filter_patch_probe__').select()
	) as PostgrestFilterPatchTarget;

	if (filterBuilderPrototype.__tinytrainReservedColumnPatch) {
		return;
	}

	const originalEq = filterBuilderPrototype.eq;
	const originalIs = filterBuilderPrototype.is;

	filterBuilderPrototype.eq = function eq(column: string, value: unknown) {
		return originalEq.call(this, quoteReservedPostgrestFilterColumn(column), value);
	};
	filterBuilderPrototype.is = function is(column: string, value: boolean | null) {
		return originalIs.call(this, quoteReservedPostgrestFilterColumn(column), value);
	};
	filterBuilderPrototype.__tinytrainReservedColumnPatch = true;
}

patchReservedPostgrestFilterColumns();

export type SupabaseAuthSnapshot = {
	session: Session | null;
	user: User | null;
	isLoading: boolean;
};

let authSnapshot: SupabaseAuthSnapshot = {
	session: null,
	user: null,
	isLoading: true
};
const authSubscribers = new Set<(snapshot: SupabaseAuthSnapshot) => void>();
let initialized = false;

function emitAuthSnapshot() {
	for (const subscriber of authSubscribers) {
		subscriber(authSnapshot);
	}
}

export async function initializeSupabaseAuth() {
	if (!browser || initialized) {
		return authSnapshot;
	}

	initialized = true;
	const { data } = await supabase.auth.getSession();
	authSnapshot = {
		session: data.session,
		user: data.session?.user ?? null,
		isLoading: false
	};
	emitAuthSnapshot();

	supabase.auth.onAuthStateChange((_event, session) => {
		authSnapshot = {
			session,
			user: session?.user ?? null,
			isLoading: false
		};
		emitAuthSnapshot();
	});

	return authSnapshot;
}

export function getSupabaseAuthSnapshot() {
	void initializeSupabaseAuth();
	return authSnapshot;
}

export function subscribeToSupabaseAuth(subscriber: (snapshot: SupabaseAuthSnapshot) => void): {
	unsubscribe(): void;
} {
	authSubscribers.add(subscriber);
	subscriber(authSnapshot);
	void initializeSupabaseAuth();

	return {
		unsubscribe() {
			authSubscribers.delete(subscriber);
		}
	};
}

export async function getSupabaseSession() {
	await initializeSupabaseAuth();
	const { data, error } = await supabase.auth.getSession();

	if (error) {
		throw error;
	}

	authSnapshot = {
		session: data.session,
		user: data.session?.user ?? null,
		isLoading: false
	};
	emitAuthSnapshot();

	return data.session;
}

export async function getSupabaseUser() {
	const session = await getSupabaseSession();
	return session?.user ?? null;
}

export async function loginWithSupabaseGoogle(redirectPath = '/') {
	const redirectTo = browser
		? new URL(resolve(redirectPath as '/'), window.location.origin).toString()
		: undefined;
	const { error } = await supabase.auth.signInWithOAuth({
		provider: 'google',
		options: {
			redirectTo
		}
	});

	if (error) {
		throw error;
	}
}

export async function reloadOnceAfterSupabaseOAuthCallback(redirectPath = '/') {
	if (!browser || !window.location.search.includes('code=')) {
		return false;
	}

	const currentCallbackUrl = `${window.location.pathname}${window.location.search}`;

	if (sessionStorage.getItem(postLoginReloadKey) === currentCallbackUrl) {
		return false;
	}

	const session = await getSupabaseSession();

	if (!session?.user) {
		return false;
	}

	sessionStorage.setItem(postLoginReloadKey, currentCallbackUrl);
	window.location.replace(new URL(resolve(redirectPath as '/'), window.location.origin).toString());
	return true;
}

export async function logoutFromSupabase() {
	const { error } = await supabase.auth.signOut();

	if (error) {
		throw error;
	}

	if (browser) {
		await goto(resolve('/login'), { replaceState: true });
	}
}
