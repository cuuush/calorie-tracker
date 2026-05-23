import { json } from '@sveltejs/kit';

export async function GET({ params, locals }) {
    if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
    const convo = await locals.storage.getChatConversation(params.id, locals.user.id);
    if (!convo) return json({ error: 'Not found' }, { status: 404 });
    return json(convo);
}

export async function DELETE({ params, locals }) {
    if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
    await locals.storage.deleteChatConversation(params.id, locals.user.id);
    return json({ ok: true });
}
