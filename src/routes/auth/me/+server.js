import { json } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ locals }) {
    if (!locals.user) {
        return json({ authenticated: false });
    }

    return json({
        authenticated: true,
        user: locals.user
    });
}
