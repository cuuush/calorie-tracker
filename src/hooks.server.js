import { dev } from '$app/environment';
import { Auth } from '$lib/server/auth';
import { Storage } from '$lib/server/storage';
import { extractSessionCookie } from '$lib/server/middleware';

// During `vite dev`, event.platform is undefined because we're not running on
// Cloudflare Workers. Pull in real bindings via wrangler's getPlatformProxy so
// D1/R2/KV all work locally against Miniflare-backed state.
let devPlatformPromise = null;
async function getDevPlatform() {
    if (!devPlatformPromise) {
        devPlatformPromise = (async () => {
            const { getPlatformProxy } = await import('wrangler');
            const proxy = await getPlatformProxy({ persist: true });
            return {
                env: proxy.env,
                context: proxy.ctx,
                caches: proxy.caches,
                cf: proxy.cf
            };
        })();
    }
    return devPlatformPromise;
}

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
    if (dev && !event.platform) {
        event.platform = await getDevPlatform();
    }

    const { platform, url } = event;

    // Redirect HTTP to HTTPS in production. Skip on localhost and during `vite dev`
    // so the dev workflow doesn't bounce to https://localhost which has no cert.
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!dev && !isLocal && url.protocol === 'http:') {
        return Response.redirect(url.href.replace('http:', 'https:'), 301);
    }

    // Inject auth and storage into event.locals for usage in routes
    if (platform?.env) {
        event.locals.auth = new Auth(platform.env);
        event.locals.storage = new Storage(platform.env);

        // Bypass auth for testing
        if (platform.env.BYPASS_AUTH === 'true') {
            event.locals.user = {
                id: 'test-user-123',
                email: 'test@example.com',
                created_at: new Date().toISOString()
            };
            const response = await resolve(event);
            return response;
        }
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
