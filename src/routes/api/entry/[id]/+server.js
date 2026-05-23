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
export async function PATCH({ params, request, locals }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = params;
    const body = await request.json();

    const entry = await locals.storage.getEntryDetails(id, locals.user.id);
    if (!entry) {
        return json({ error: 'Entry not found' }, { status: 404 });
    }

    if (body.timestamp) entry.timestamp = body.timestamp;
    if (body.meal_title !== undefined) entry.meal_title = body.meal_title;

    // saveEntry expects `messages` not `conversation_messages`; preserve them
    if (entry.conversation_messages && !entry.messages) {
        entry.messages = entry.conversation_messages;
    }

    const saved = await locals.storage.saveEntry(entry, locals.user.id);
    return json({ success: true, timestamp: saved.timestamp, meal_title: saved.meal_title });
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
