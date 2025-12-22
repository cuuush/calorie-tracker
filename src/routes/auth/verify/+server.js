import { setSessionCookie } from '$lib/server/middleware';

/** @type {import('./$types').RequestHandler} */
export async function GET({ url, locals, platform }) {
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

        // Set session cookie and redirect to app
        return new Response(null, {
            status: 302,
            headers: {
                'Location': '/',
                'Set-Cookie': setSessionCookie(result.sessionToken, isDev)
            }
        });
    } catch (error) {
        console.error('Verify error:', error);
        return new Response('Verification failed', { status: 500 });
    }
}
