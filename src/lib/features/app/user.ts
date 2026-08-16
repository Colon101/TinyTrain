export type CloudUser = {
	userId?: string;
	name?: string;
	email?: string;
	isLoggedIn?: boolean;
	isLoading?: boolean;
};

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
