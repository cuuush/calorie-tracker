import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const entryData = await request.json();
    const doc = await locals.storage.saveEntry(entryData, locals.user.id);

    return json(doc);
}
