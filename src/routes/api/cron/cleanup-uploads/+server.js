import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    const secret = request.headers.get('authorization');
    if (!platform?.env?.CRON_SECRET || secret !== `Bearer ${platform.env.CRON_SECRET}`) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const deleted = await locals.storage.cleanupPendingUploads();
    return json({ ok: true, deleted });
}
