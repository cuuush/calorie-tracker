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
export async function PATCH({ params, request, locals, platform }) {
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
    if (Array.isArray(body.items)) {
        entry.items = body.items;
        entry.total_calories = body.items.reduce((s, i) => s + (i.calories || 0), 0);
        entry.total_protein = Math.round(body.items.reduce((s, i) => s + (i.protein || 0), 0));
        entry.total_carbs = body.items.reduce((s, i) => s + (i.carbs || 0), 0);
    }
    if (body.status) entry.status = body.status;

    // saveEntry expects `messages` not `conversation_messages`; preserve them
    if (entry.conversation_messages && !entry.messages) {
        entry.messages = entry.conversation_messages;
    }

    const saved = await locals.storage.saveEntry(entry, locals.user.id);

    // On commit, drop any lingering pending uploads associated with this entry.
    if (body.status === 'committed') {
        const keysToDrop = [...(entry.image_keys || []), entry.audio_key].filter(Boolean);
        if (keysToDrop.length > 0 && platform?.env?.IMAGES) {
            const cleanup = Promise.all(
                keysToDrop.map((k) => platform.env.IMAGES.delete(k).catch(() => {}))
            );
            platform?.context?.waitUntil?.(cleanup);
        }
    }

    return json({
        success: true,
        timestamp: saved.timestamp,
        meal_title: saved.meal_title,
        status: saved.status
    });
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
