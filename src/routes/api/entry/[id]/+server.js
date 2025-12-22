import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ params, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = params;
    const entry = await locals.storage.getEntryDetails(id, locals.user.id);

    if (!entry) {
        return json({ error: 'Entry not found' }, { status: 404 });
    }

    return json(entry);
}

/** @type {import('./$types').RequestHandler} */
export async function DELETE({ params, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = params;
    await locals.storage.deleteEntry(id, locals.user.id);

    return json({ success: true });
}
