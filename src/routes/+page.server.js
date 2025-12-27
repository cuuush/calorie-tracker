/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
	if (!locals.user) {
		return {
			settings: null,
			stats: null
		};
	}

	// Load both settings and stats server-side for instant initial render
	// This eliminates the need for client-side fetches on page load
	const [settings, stats] = await Promise.all([
		locals.storage.getUserSettings(locals.user.id),
		locals.storage.getStats(locals.user.id)
	]);

	return {
		settings: settings || {},
		stats: stats || {
			todayTotal: 0,
			todayProtein: 0,
			groups: { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 },
			proteinGroups: { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 },
			weeklyData: [0, 0, 0, 0, 0, 0, 0],
			weeklyProteinData: [0, 0, 0, 0, 0, 0, 0]
		}
	};
}
