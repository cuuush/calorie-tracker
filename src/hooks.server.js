import { Auth } from '$lib/server/auth';
import { Storage } from '$lib/server/storage';
import { extractSessionCookie } from '$lib/server/middleware';

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
    const { platform, url } = event;

    // Redirect HTTP to HTTPS in production
    const isDev = platform?.env?.DEV === 'true' || platform?.env?.DEV === true;
    if (!isDev && url.protocol === 'http:') {
        return Response.redirect(url.href.replace('http:', 'https:'), 301);
    }

    // Inject auth and storage into event.locals for usage in routes
    if (platform?.env) {
        event.locals.auth = new Auth(platform.env);
        event.locals.storage = new Storage(platform.env);
    }

    const sessionToken = event.cookies.get('session');

    if (sessionToken && event.locals.auth) {
        const userId = await event.locals.auth.validateSession(sessionToken);
        if (userId) {
            event.locals.user = await event.locals.auth.getUser(userId);
        }
    }

    const response = await resolve(event);
    return response;
}
