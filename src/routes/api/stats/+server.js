import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ locals, url }) {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Get client's current date from query parameter (format: YYYY-MM-DD)
	const clientDate = url.searchParams.get('date');
	const stats = await locals.storage.getStats(locals.user.id, clientDate);
	return json(stats);
}
