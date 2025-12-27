import { json } from '@sveltejs/kit';

export async function GET({ url, locals }) {
	// Auth check
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const query = url.searchParams.get('q');

	if (!query || query.length < 3) {
		return json([]);
	}

	const db = locals.storage.db;
	const searchPattern = `%${query}%`;

	// Use window functions to get unique meal titles with counts and most recent entry data
	// CRITICAL: Filter by user_id to prevent seeing other users' meals
	const results = await db.prepare(`
		WITH ranked AS (
			SELECT
				meal_title,
				id,
				items,
				total_calories,
				total_protein,
				total_carbs,
				user_message,
				ROW_NUMBER() OVER (PARTITION BY meal_title ORDER BY timestamp DESC) as rn,
				COUNT(*) OVER (PARTITION BY meal_title) as count
			FROM nutrition_entries
			WHERE user_id = ? AND meal_title LIKE ? COLLATE NOCASE
		)
		SELECT
			meal_title,
			id,
			items,
			total_calories,
			total_protein,
			total_carbs,
			user_message,
			count
		FROM ranked
		WHERE rn = 1
		ORDER BY count DESC
		LIMIT 5
	`).bind(locals.user.id, searchPattern).all();

	return json(results.results || []);
}
