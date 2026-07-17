export function isSessionExerciseRoute(targetPathname: string, sessionOverviewPath: string) {
	const exercisePathPrefix = `${sessionOverviewPath.replace(/\/$/, '')}/exercises/`;

	if (!targetPathname.startsWith(exercisePathPrefix)) {
		return false;
	}

	const sessionExerciseId = targetPathname.slice(exercisePathPrefix.length);

	return Boolean(sessionExerciseId) && !sessionExerciseId.includes('/');
}
