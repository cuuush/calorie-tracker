/** @type {import('./$types').PageServerLoad} */
export async function load({ locals, cookies }) {
	if (!locals.user) {
		return {
			settings: null,
			stats: null,
			tz_used: null
		};
	}

	const tz = cookies.get('tz') || 'UTC';

	// Load both settings and stats server-side for instant initial render
	// This eliminates the need for client-side fetches on page load
	const [settings, stats] = await Promise.all([
		locals.storage.getUserSettings(locals.user.id),
		locals.storage.getStats(locals.user.id, null, tz)
	]);

	let mealPlaceholder;
	try {
		const hour = new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getHours();
		if (hour >= 4 && hour < 11) mealPlaceholder = "What's for breakfast?";
		else if (hour >= 11 && hour < 16) mealPlaceholder = "What's for lunch?";
		else if (hour >= 16 && hour < 22) mealPlaceholder = "What's for dinner?";
		else mealPlaceholder = 'late night snack?';
	} catch {
		mealPlaceholder = "What's for dinner?";
	}

	return {
		settings: settings || {},
		stats: stats || {
			todayTotal: 0,
			todayProtein: 0,
			groups: { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 },
			proteinGroups: { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 },
			weeklyData: [0, 0, 0, 0, 0, 0, 0],
			weeklyProteinData: [0, 0, 0, 0, 0, 0, 0]
		},
		tz_used: tz,
		mealPlaceholder
	};
}
