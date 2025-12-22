// Authentication middleware helpers

// Extract session token from cookie header
export function extractSessionCookie(cookieHeader) {
    if (!cookieHeader) {
        return null;
    }

    const match = cookieHeader.match(/session=([^;]+)/);
    return match ? match[1] : null;
}

// Require authentication - returns userId or null
export async function requireAuth(request, auth) {
    const cookie = request.headers.get('Cookie');
    if (!cookie) {
        return null;
    }

    const sessionToken = extractSessionCookie(cookie);
    if (!sessionToken) {
        return null;
    }

    const userId = await auth.validateSession(sessionToken);
    return userId;
}

// Create session cookie with HTTP-only, Secure, SameSite=Lax
export function setSessionCookie(sessionToken, isDev = false) {
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    const secure = isDev ? '' : ' Secure;';

    return `session=${sessionToken}; Path=/; HttpOnly;${secure} SameSite=Lax; Expires=${expires.toUTCString()}`;
}

// Clear session cookie
export function clearSessionCookie(isDev = false) {
    const secure = isDev ? '' : ' Secure;';
    return `session=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}
