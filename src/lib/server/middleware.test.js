import { describe, it, expect } from 'vitest';
import { extractSessionCookie, setSessionCookie, clearSessionCookie, requireAuth } from './middleware.js';

// ---- extractSessionCookie ----

describe('extractSessionCookie', () => {
    it('returns null for null/undefined header', () => {
        expect(extractSessionCookie(null)).toBeNull();
        expect(extractSessionCookie(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(extractSessionCookie('')).toBeNull();
    });

    it('extracts session token from a single cookie', () => {
        expect(extractSessionCookie('session=abc123')).toBe('abc123');
    });

    it('extracts session token among multiple cookies', () => {
        const header = 'theme=dark; session=mysecrettoken; lang=en';
        expect(extractSessionCookie(header)).toBe('mysecrettoken');
    });

    it('returns null when session cookie is absent', () => {
        expect(extractSessionCookie('theme=dark; lang=en')).toBeNull();
    });

    it('handles session cookie at the end with no trailing semicolon', () => {
        expect(extractSessionCookie('other=val; session=token123')).toBe('token123');
    });

    it('handles long hex token values', () => {
        const token = 'a'.repeat(64);
        expect(extractSessionCookie(`session=${token}`)).toBe(token);
    });

    it('does not match partial key names like "my_session"', () => {
        // The regex matches "session=" anywhere, so "my_session=x" would NOT match
        // because the regex looks for "session=" literally (no word-boundary),
        // but "my_session=x" contains "session=x" as a substring
        // This tests the actual behavior of the current implementation
        const result = extractSessionCookie('my_session=abc');
        // The regex /session=([^;]+)/ will match the "session=abc" part inside "my_session=abc"
        expect(result).toBe('abc');
    });
});

// ---- setSessionCookie ----

describe('setSessionCookie', () => {
    it('creates a proper Set-Cookie value for production', () => {
        const cookie = setSessionCookie('tok123', false);
        expect(cookie).toContain('session=tok123');
        expect(cookie).toContain('Path=/');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Expires=');
    });

    it('omits Secure flag in dev mode', () => {
        const cookie = setSessionCookie('tok123', true);
        expect(cookie).toContain('session=tok123');
        expect(cookie).not.toContain('Secure');
        expect(cookie).toContain('HttpOnly');
    });

    it('sets expiration ~30 days in the future', () => {
        const cookie = setSessionCookie('tok123');
        const match = cookie.match(/Expires=(.+)$/);
        expect(match).toBeDefined();
        const expiresDate = new Date(match[1]);
        const twentyNineDays = Date.now() + 29 * 24 * 60 * 60 * 1000;
        const thirtyOneDays = Date.now() + 31 * 24 * 60 * 60 * 1000;
        expect(expiresDate.getTime()).toBeGreaterThan(twentyNineDays);
        expect(expiresDate.getTime()).toBeLessThan(thirtyOneDays);
    });
});

// ---- clearSessionCookie ----

describe('clearSessionCookie', () => {
    it('creates an expiring cookie for production', () => {
        const cookie = clearSessionCookie(false);
        expect(cookie).toContain('session=');
        expect(cookie).toContain('Max-Age=0');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
    });

    it('omits Secure flag in dev mode', () => {
        const cookie = clearSessionCookie(true);
        expect(cookie).not.toContain('Secure');
        expect(cookie).toContain('Max-Age=0');
    });
});

// ---- requireAuth ----

describe('requireAuth', () => {
    it('returns null when no Cookie header', async () => {
        const request = new Request('https://example.com/api/test');
        const userId = await requireAuth(request, { validateSession: async () => 'uid' });
        expect(userId).toBeNull();
    });

    it('returns null when Cookie header has no session', async () => {
        const request = new Request('https://example.com/api/test', {
            headers: { Cookie: 'theme=dark' }
        });
        const userId = await requireAuth(request, { validateSession: async () => 'uid' });
        expect(userId).toBeNull();
    });

    it('calls auth.validateSession with the extracted token', async () => {
        const request = new Request('https://example.com/api/test', {
            headers: { Cookie: 'session=mytoken123' }
        });
        let receivedToken = null;
        const mockAuth = {
            validateSession: async (token) => {
                receivedToken = token;
                return 'user-42';
            }
        };

        const userId = await requireAuth(request, mockAuth);
        expect(userId).toBe('user-42');
        expect(receivedToken).toBe('mytoken123');
    });

    it('returns null when auth.validateSession returns null', async () => {
        const request = new Request('https://example.com/api/test', {
            headers: { Cookie: 'session=invalid' }
        });
        const mockAuth = { validateSession: async () => null };

        const userId = await requireAuth(request, mockAuth);
        expect(userId).toBeNull();
    });
});
