import { json } from '@sveltejs/kit';

export async function GET({ locals }) {
    if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
    const items = await locals.storage.listChatConversations(locals.user.id, 50);
    return json(items);
}
