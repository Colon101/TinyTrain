export function load({ params }) {
	return {
		sessionId: params.sessionId,
		sessionExerciseId: params.sessionExerciseId
	};
}
