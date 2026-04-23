export type CloudUser = {
	userId?: string;
	name?: string;
	email?: string;
	claims?: Record<string, unknown>;
	isLoggedIn?: boolean;
	isLoading?: boolean;
	license?: {
		status?: string;
	};
};

const IMAGE_CLAIM_KEYS = ['picture', 'avatar_url', 'photo', 'image'];

export function getUserAvatarUrl(user: CloudUser | null | undefined) {
	const claims = user?.claims;

	if (!claims) {
		return null;
	}

	for (const key of IMAGE_CLAIM_KEYS) {
		const value = claims[key];

		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}

	return null;
}

export function getUserDisplayName(user: CloudUser | null | undefined) {
	return user?.name || user?.email || 'Your account';
}

export function getUserInitials(user: CloudUser | null | undefined) {
	const seed = getUserDisplayName(user).trim();
	const parts = seed.split(/\s+/).filter(Boolean);

	if (parts.length >= 2) {
		return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
	}

	return seed.slice(0, 2).toUpperCase();
}
