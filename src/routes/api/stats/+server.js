import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ locals, url, cookies }) {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Get client's current date from query parameter (format: YYYY-MM-DD)
	const clientDate = url.searchParams.get('date');
	const tz = cookies.get('tz') || 'UTC';
	const stats = await locals.storage.getStats(locals.user.id, clientDate, tz);
	return json(stats);
}
