import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function POST({ locals, cookies }) {
    try {
        const { auth } = locals;
        const sessionToken = cookies.get('session');
        if (sessionToken) {
            await auth.deleteSession(sessionToken);
        }

        cookies.delete('session', { path: '/' });

        return json({ success: true });
    } catch (error) {
        console.error('Logout error:', error);
        return json({ error: error.message }, { status: 500 });
    }
}
