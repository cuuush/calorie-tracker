import { json } from '@sveltejs/kit';
import { clearSessionCookie, extractSessionCookie } from '$lib/server/middleware';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    try {
        const { auth } = locals;
        const cookie = request.headers.get('Cookie');
        if (cookie) {
            const sessionToken = extractSessionCookie(cookie);
            if (sessionToken) {
                await auth.deleteSession(sessionToken);
            }
        }

        const isDev = platform?.env?.DEV === 'true' || platform?.env?.DEV === true;

        return json({ success: true }, {
            headers: {
                'Set-Cookie': clearSessionCookie(isDev)
            }
        });
    } catch (error) {
        console.error('Logout error:', error);
        return json({ error: error.message }, { status: 500 });
    }
}
