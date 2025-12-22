import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals }) {
    try {
        const { auth } = locals;
        const { email } = await request.json();

        if (!email) {
            return json({ error: 'Email required' }, { status: 400 });
        }

        await auth.sendMagicLink(email, request);

        return json({ success: true });
    } catch (error) {
        console.error('Login error:', error);
        return json({ error: error.message }, { status: 500 });
    }
}
