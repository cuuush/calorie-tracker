import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, cookies, locals }) {
    if (!locals.auth) {
        return json({ error: 'Server not initialized' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const { qr_id, device_secret } = body;

    const result = await locals.auth.claimQrSession(qr_id, device_secret);

    if (result.status === 'approved' && result.session_token) {
        cookies.set('session', result.session_token, {
            path: '/',
            httpOnly: true,
            secure: !dev,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60
        });
        return json({ status: 'approved' });
    }

    return json({ status: result.status });
}
