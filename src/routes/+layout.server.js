import { redirect } from '@sveltejs/kit';

/** @type {import('./$types').LayoutServerLoad} */
export async function load({ locals, url }) {
    const isLogin = url.pathname === '/login';
    const isVerify = url.pathname === '/auth/verify';

    if (!locals.user && !isLogin && !isVerify) {
        throw redirect(302, '/login');
    }

    if (locals.user && isLogin) {
        throw redirect(302, '/');
    }

    return {
        user: locals.user
    };
}
