import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await locals.storage.getUserSettings(locals.user.id);
    return json(settings || {});
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await request.json();
    const updated = await locals.storage.saveUserSettings(settings, locals.user.id);
    return json(updated);
}
