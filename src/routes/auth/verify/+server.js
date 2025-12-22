import { redirect } from '@sveltejs/kit';

/** @type {import('./$types').RequestHandler} */
export async function GET({ url, locals, platform, cookies }) {
    try {
        const { auth } = locals;
        const token = url.searchParams.get('token');

        if (!token) {
            return new Response('Missing token', { status: 400 });
        }

        const result = await auth.verifyToken(token);

        if (!result) {
            return new Response('Invalid or expired token', { status: 400 });
        }

        const isDev = platform?.env?.DEV === 'true' || platform?.env?.DEV === true;

        cookies.set('session', result.sessionToken, {
            path: '/',
            httpOnly: true,
            secure: !isDev,
            sameSite: 'lax',
            maxAge: 60 * 60 * 24 * 30 // 30 days
        });

        throw redirect(302, '/');
    } catch (error) {
        if (error.status === 302) throw error;
        console.error('Verify error:', error);
        return new Response('Verification failed', { status: 500 });
    }
}
