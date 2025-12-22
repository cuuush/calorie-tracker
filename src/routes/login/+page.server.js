import { fail } from '@sveltejs/kit';

/** @type {import('./$types').Actions} */
export const actions = {
    login: async ({ request, locals }) => {
        const { auth } = locals;
        const formData = await request.formData();
        const email = formData.get('email');

        if (!email) {
            return fail(400, { email, missing: true });
        }

        try {
            await auth.sendMagicLink(email.toString(), request);
            return { success: true, sentEmail: email.toString() };
        } catch (error) {
            console.error('Login error:', error);
            return fail(500, { email, error: error.message });
        }
    }
};
