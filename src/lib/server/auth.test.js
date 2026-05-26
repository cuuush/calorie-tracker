import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { applySchema, resetAll, TEST_USER_ID, TEST_USER_EMAIL } from '../../tests/setup.js';
import { Auth } from './auth.js';

let proxy, auth;

beforeAll(async () => {
    const { getPlatformProxy } = await import('wrangler');
    proxy = await getPlatformProxy({ persist: false });
    await applySchema(proxy.env.DB);
    auth = new Auth({
        DB: proxy.env.DB,
        CACHE: proxy.env.CACHE,
        RESEND_API_KEY: 'test-resend-key',
        APP_URL: 'https://test.example.com'
    });
});

beforeEach(async () => {
    await resetAll(proxy.env);
});

afterAll(async () => {
    await proxy.dispose();
});

// ---- Pure / utility methods ----

describe('Auth.isValidEmail', () => {
    it('accepts a standard email', () => {
        expect(auth.isValidEmail('user@example.com')).toBe(true);
    });

    it('accepts email with subdomain', () => {
        expect(auth.isValidEmail('user@mail.example.com')).toBe(true);
    });

    it('accepts email with plus addressing', () => {
        expect(auth.isValidEmail('user+tag@example.com')).toBe(true);
    });

    it('rejects empty string', () => {
        expect(auth.isValidEmail('')).toBe(false);
    });

    it('rejects missing @', () => {
        expect(auth.isValidEmail('userexample.com')).toBe(false);
    });

    it('rejects missing domain', () => {
        expect(auth.isValidEmail('user@')).toBe(false);
    });

    it('rejects missing local part', () => {
        expect(auth.isValidEmail('@example.com')).toBe(false);
    });

    it('rejects spaces', () => {
        expect(auth.isValidEmail('user @example.com')).toBe(false);
    });

    it('rejects missing TLD', () => {
        expect(auth.isValidEmail('user@example')).toBe(false);
    });
});

describe('Auth.generateToken', () => {
    it('returns a 64-character hex string', () => {
        const token = auth.generateToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns different values on each call', () => {
        const a = auth.generateToken();
        const b = auth.generateToken();
        expect(a).not.toBe(b);
    });
});

describe('Auth.generateShortToken', () => {
    it('returns a 32-character hex string', () => {
        const token = auth.generateShortToken();
        expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it('returns different values on each call', () => {
        const a = auth.generateShortToken();
        const b = auth.generateShortToken();
        expect(a).not.toBe(b);
    });
});

describe('Auth.hashSecret', () => {
    it('returns a 64-character hex string (SHA-256)', async () => {
        const hash = await auth.hashSecret('hello');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same hash for the same input', async () => {
        const a = await auth.hashSecret('test-secret');
        const b = await auth.hashSecret('test-secret');
        expect(a).toBe(b);
    });

    it('returns different hashes for different inputs', async () => {
        const a = await auth.hashSecret('secret-a');
        const b = await auth.hashSecret('secret-b');
        expect(a).not.toBe(b);
    });
});

// ---- sendMagicLink ----

describe('Auth.sendMagicLink', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('creates a verification_token row and calls Resend API', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ id: 'email-id' }), { status: 200 })
        );

        const request = new Request('https://app.example.com/api/auth/login', {
            method: 'POST'
        });

        const result = await auth.sendMagicLink('new@example.com', request);
        expect(result).toEqual({ success: true });

        // Verify token was stored in D1
        const row = await proxy.env.DB.prepare(
            'SELECT * FROM verification_tokens WHERE email = ?'
        ).bind('new@example.com').first();

        expect(row).toBeDefined();
        expect(row.email).toBe('new@example.com');
        expect(row.used).toBe(0);
        expect(row.token).toMatch(/^[0-9a-f]{64}$/);

        // Verify fetch was called with Resend API
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('https://api.resend.com/emails');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Authorization']).toBe('Bearer test-resend-key');

        const body = JSON.parse(opts.body);
        expect(body.to).toEqual(['new@example.com']);
        expect(body.html).toContain('token=');
    });

    it('throws on invalid email', async () => {
        const request = new Request('https://app.example.com/api/auth/login');
        await expect(auth.sendMagicLink('bad-email', request)).rejects.toThrow('Invalid email format');
    });

    it('throws when Resend API returns an error', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response('Unauthorized', { status: 401 })
        );

        const request = new Request('https://app.example.com/api/auth/login');
        await expect(auth.sendMagicLink('user@example.com', request))
            .rejects.toThrow('Failed to send email');
    });

    it('lowercases the email before storing', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ id: 'email-id' }), { status: 200 })
        );

        const request = new Request('https://app.example.com/api/auth/login');
        await auth.sendMagicLink('User@Example.COM', request);

        const row = await proxy.env.DB.prepare(
            'SELECT * FROM verification_tokens WHERE email = ?'
        ).bind('user@example.com').first();
        expect(row).toBeDefined();
    });
});

// ---- verifyToken ----

describe('Auth.verifyToken', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    async function insertVerificationToken(email, token, expiresAt, used = 0) {
        await proxy.env.DB.prepare(`
            INSERT INTO verification_tokens (token, email, expires_at, used)
            VALUES (?, ?, ?, ?)
        `).bind(token, email, expiresAt, used).run();
    }

    it('returns null for null/empty token', async () => {
        expect(await auth.verifyToken(null)).toBeNull();
        expect(await auth.verifyToken('')).toBeNull();
    });

    it('returns null for non-existent token', async () => {
        const result = await auth.verifyToken('nonexistent-token-abc123');
        expect(result).toBeNull();
    });

    it('returns null for expired token', async () => {
        const pastDate = new Date(Date.now() - 60000).toISOString();
        await insertVerificationToken('user@example.com', 'expired-token', pastDate);

        const result = await auth.verifyToken('expired-token');
        expect(result).toBeNull();
    });

    it('returns null for already-used token', async () => {
        const futureDate = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await insertVerificationToken('user@example.com', 'used-token', futureDate, 1);

        const result = await auth.verifyToken('used-token');
        expect(result).toBeNull();
    });

    it('creates a new user and session for a valid token with unknown email', async () => {
        const futureDate = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await insertVerificationToken('brand-new@example.com', 'valid-token', futureDate);

        const result = await auth.verifyToken('valid-token');

        expect(result).toBeDefined();
        expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/);
        expect(result.user.email).toBe('brand-new@example.com');
        expect(result.user.id).toBeDefined();

        // Verify user was created in DB
        const user = await proxy.env.DB.prepare('SELECT * FROM users WHERE email = ?')
            .bind('brand-new@example.com').first();
        expect(user).toBeDefined();

        // Verify session was created
        const session = await proxy.env.DB.prepare('SELECT * FROM sessions WHERE token = ?')
            .bind(result.sessionToken).first();
        expect(session).toBeDefined();
        expect(session.user_id).toBe(result.user.id);

        // Verify token was marked as used
        const tokenRow = await proxy.env.DB.prepare(
            'SELECT used FROM verification_tokens WHERE token = ?'
        ).bind('valid-token').first();
        expect(tokenRow.used).toBe(1);
    });

    it('returns existing user for a valid token with known email', async () => {
        // TEST_USER_ID / TEST_USER_EMAIL was seeded by resetAll
        const futureDate = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await insertVerificationToken(TEST_USER_EMAIL, 'existing-user-token', futureDate);

        const result = await auth.verifyToken('existing-user-token');

        expect(result).toBeDefined();
        expect(result.user.id).toBe(TEST_USER_ID);
        expect(result.user.email).toBe(TEST_USER_EMAIL);
    });

    it('end-to-end via sendMagicLink then verifyToken', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ id: 'email-id' }), { status: 200 })
        );

        const request = new Request('https://app.example.com/api/auth/login');
        await auth.sendMagicLink('e2e@example.com', request);

        // Grab the token from DB
        const row = await proxy.env.DB.prepare(
            'SELECT token FROM verification_tokens WHERE email = ?'
        ).bind('e2e@example.com').first();

        const result = await auth.verifyToken(row.token);
        expect(result).toBeDefined();
        expect(result.user.email).toBe('e2e@example.com');
        expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    });
});

// ---- validateSession ----

describe('Auth.validateSession', () => {
    async function createSessionForUser(userId, token, expiresAt, lastUsedAt) {
        await proxy.env.DB.prepare(`
            INSERT INTO sessions (token, user_id, expires_at, last_used_at)
            VALUES (?, ?, ?, ?)
        `).bind(token, userId, expiresAt, lastUsedAt || new Date().toISOString()).run();
    }

    it('returns null for null/empty token', async () => {
        expect(await auth.validateSession(null)).toBeNull();
        expect(await auth.validateSession('')).toBeNull();
    });

    it('returns null for non-existent session', async () => {
        const result = await auth.validateSession('no-such-session');
        expect(result).toBeNull();
    });

    it('returns userId for a valid session', async () => {
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await createSessionForUser(TEST_USER_ID, 'valid-session', future, new Date().toISOString());

        const userId = await auth.validateSession('valid-session');
        expect(userId).toBe(TEST_USER_ID);
    });

    it('returns null for an expired session and deletes it', async () => {
        const past = new Date(Date.now() - 60000).toISOString();
        await createSessionForUser(TEST_USER_ID, 'expired-session', past, past);

        const userId = await auth.validateSession('expired-session');
        expect(userId).toBeNull();

        // Session should be deleted
        const row = await proxy.env.DB.prepare(
            'SELECT * FROM sessions WHERE token = ?'
        ).bind('expired-session').first();
        expect(row).toBeNull();
    });

    it('caches in KV on first call and returns from cache on second', async () => {
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await createSessionForUser(TEST_USER_ID, 'cache-test-session', future, new Date().toISOString());

        // First call: cache miss, should hit D1 and populate KV
        const userId1 = await auth.validateSession('cache-test-session');
        expect(userId1).toBe(TEST_USER_ID);

        // Verify KV was populated
        const cached = await proxy.env.CACHE.get('session:cache-test-session', 'json');
        expect(cached).toEqual({ userId: TEST_USER_ID });

        // Delete the session from D1 to prove the second call comes from cache
        await proxy.env.DB.prepare('DELETE FROM sessions WHERE token = ?')
            .bind('cache-test-session').run();

        // Second call: should return from cache
        const userId2 = await auth.validateSession('cache-test-session');
        expect(userId2).toBe(TEST_USER_ID);
    });
});

// ---- deleteSession ----

describe('Auth.deleteSession', () => {
    it('does nothing for null token', async () => {
        await auth.deleteSession(null); // should not throw
    });

    it('removes session from D1 and KV cache', async () => {
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await proxy.env.DB.prepare(`
            INSERT INTO sessions (token, user_id, expires_at)
            VALUES (?, ?, ?)
        `).bind('delete-me', TEST_USER_ID, future).run();

        // Populate KV cache
        await proxy.env.CACHE.put('session:delete-me', JSON.stringify({ userId: TEST_USER_ID }));

        await auth.deleteSession('delete-me');

        // D1 row gone
        const row = await proxy.env.DB.prepare('SELECT * FROM sessions WHERE token = ?')
            .bind('delete-me').first();
        expect(row).toBeNull();

        // KV cache cleared
        const cached = await proxy.env.CACHE.get('session:delete-me');
        expect(cached).toBeNull();
    });
});

// ---- cleanupExpired ----

describe('Auth.cleanupExpired', () => {
    it('removes expired tokens, used tokens, expired sessions, and expired QR requests', async () => {
        const past = new Date(Date.now() - 60000).toISOString();
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        // Expired verification token
        await proxy.env.DB.prepare(`
            INSERT INTO verification_tokens (token, email, expires_at, used)
            VALUES (?, ?, ?, 0)
        `).bind('expired-vt', 'a@b.com', past).run();

        // Used verification token (should also be deleted)
        await proxy.env.DB.prepare(`
            INSERT INTO verification_tokens (token, email, expires_at, used)
            VALUES (?, ?, ?, 1)
        `).bind('used-vt', 'c@d.com', future).run();

        // Valid verification token (should remain)
        await proxy.env.DB.prepare(`
            INSERT INTO verification_tokens (token, email, expires_at, used)
            VALUES (?, ?, ?, 0)
        `).bind('valid-vt', 'e@f.com', future).run();

        // Expired session
        await proxy.env.DB.prepare(`
            INSERT INTO sessions (token, user_id, expires_at)
            VALUES (?, ?, ?)
        `).bind('expired-sess', TEST_USER_ID, past).run();

        // Valid session (should remain)
        await proxy.env.DB.prepare(`
            INSERT INTO sessions (token, user_id, expires_at)
            VALUES (?, ?, ?)
        `).bind('valid-sess', TEST_USER_ID, future).run();

        // Expired QR request
        const deviceHash = await auth.hashSecret('some-secret');
        await proxy.env.DB.prepare(`
            INSERT INTO qr_login_requests (qr_id, device_secret_hash, status, expires_at)
            VALUES (?, ?, 'pending', ?)
        `).bind('expired-qr', deviceHash, past).run();

        // Valid QR request (should remain)
        await proxy.env.DB.prepare(`
            INSERT INTO qr_login_requests (qr_id, device_secret_hash, status, expires_at)
            VALUES (?, ?, 'pending', ?)
        `).bind('valid-qr', deviceHash, future).run();

        await auth.cleanupExpired();

        // Check verification tokens
        const expiredVT = await proxy.env.DB.prepare(
            'SELECT * FROM verification_tokens WHERE token = ?'
        ).bind('expired-vt').first();
        expect(expiredVT).toBeNull();

        const usedVT = await proxy.env.DB.prepare(
            'SELECT * FROM verification_tokens WHERE token = ?'
        ).bind('used-vt').first();
        expect(usedVT).toBeNull();

        const validVT = await proxy.env.DB.prepare(
            'SELECT * FROM verification_tokens WHERE token = ?'
        ).bind('valid-vt').first();
        expect(validVT).toBeDefined();

        // Check sessions
        const expiredSess = await proxy.env.DB.prepare(
            'SELECT * FROM sessions WHERE token = ?'
        ).bind('expired-sess').first();
        expect(expiredSess).toBeNull();

        const validSess = await proxy.env.DB.prepare(
            'SELECT * FROM sessions WHERE token = ?'
        ).bind('valid-sess').first();
        expect(validSess).toBeDefined();

        // Check QR requests
        const expiredQR = await proxy.env.DB.prepare(
            'SELECT * FROM qr_login_requests WHERE qr_id = ?'
        ).bind('expired-qr').first();
        expect(expiredQR).toBeNull();

        const validQR = await proxy.env.DB.prepare(
            'SELECT * FROM qr_login_requests WHERE qr_id = ?'
        ).bind('valid-qr').first();
        expect(validQR).toBeDefined();
    });
});

// ---- getUser ----

describe('Auth.getUser', () => {
    it('returns user by id', async () => {
        const user = await auth.getUser(TEST_USER_ID);
        expect(user).toBeDefined();
        expect(user.id).toBe(TEST_USER_ID);
        expect(user.email).toBe(TEST_USER_EMAIL);
    });

    it('returns null for unknown user', async () => {
        const user = await auth.getUser('nonexistent-user-id');
        expect(user).toBeNull();
    });
});

// ---- QR login flow ----

describe('QR login flow', () => {
    it('createQrRequest returns qr_id, device_secret, and expires_at', async () => {
        const result = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'TestBrowser', country: 'US' });
        expect(result.qr_id).toMatch(/^[0-9a-f]{32}$/);
        expect(result.device_secret).toMatch(/^[0-9a-f]{64}$/);
        expect(result.expires_at).toBeDefined();

        // Row should exist in DB
        const row = await proxy.env.DB.prepare(
            'SELECT * FROM qr_login_requests WHERE qr_id = ?'
        ).bind(result.qr_id).first();
        expect(row).toBeDefined();
        expect(row.status).toBe('pending');
        expect(row.created_ip).toBe('1.2.3.4');
        expect(row.created_ua).toBe('TestBrowser');
        expect(row.created_country).toBe('US');
    });

    it('getQrRequest returns request details', async () => {
        const { qr_id } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'TestBrowser', country: 'US' });
        const req = await auth.getQrRequest(qr_id);
        expect(req).toBeDefined();
        expect(req.qr_id).toBe(qr_id);
        expect(req.status).toBe('pending');
    });

    it('getQrRequest returns null for null input', async () => {
        const req = await auth.getQrRequest(null);
        expect(req).toBeNull();
    });

    it('full approval flow: create → approve → claim returns session', async () => {
        const { qr_id, device_secret } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'TestBrowser', country: 'US' });

        // Phone approves with the test user
        const approveResult = await auth.approveQrRequest(qr_id, TEST_USER_ID);
        expect(approveResult).toEqual({ success: true });

        // Laptop claims using device_secret
        const claimResult = await auth.claimQrSession(qr_id, device_secret);
        expect(claimResult.status).toBe('approved');
        expect(claimResult.session_token).toMatch(/^[0-9a-f]{64}$/);

        // Verify the session is valid
        const userId = await auth.validateSession(claimResult.session_token);
        expect(userId).toBe(TEST_USER_ID);

        // QR request should be deleted after claim
        const row = await proxy.env.DB.prepare(
            'SELECT * FROM qr_login_requests WHERE qr_id = ?'
        ).bind(qr_id).first();
        expect(row).toBeNull();
    });

    it('denial flow: create → deny → claim returns denied', async () => {
        const { qr_id, device_secret } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });

        const denyResult = await auth.denyQrRequest(qr_id);
        expect(denyResult).toEqual({ success: true });

        const claimResult = await auth.claimQrSession(qr_id, device_secret);
        expect(claimResult.status).toBe('denied');
    });

    it('claimQrSession returns invalid for wrong device_secret', async () => {
        const { qr_id } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });

        const claimResult = await auth.claimQrSession(qr_id, 'wrong-secret');
        expect(claimResult.status).toBe('invalid');
    });

    it('claimQrSession returns invalid for null inputs', async () => {
        expect(await auth.claimQrSession(null, 'secret')).toEqual({ status: 'invalid' });
        expect(await auth.claimQrSession('qr', null)).toEqual({ status: 'invalid' });
    });

    it('claimQrSession returns expired for non-existent qr_id', async () => {
        const result = await auth.claimQrSession('nonexistent', 'secret');
        expect(result.status).toBe('expired');
    });

    it('approveQrRequest returns not_found for unknown qr_id', async () => {
        const result = await auth.approveQrRequest('nonexistent', TEST_USER_ID);
        expect(result).toEqual({ error: 'not_found' });
    });

    it('approveQrRequest returns already_handled if already approved', async () => {
        const { qr_id } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });
        await auth.approveQrRequest(qr_id, TEST_USER_ID);

        const result = await auth.approveQrRequest(qr_id, TEST_USER_ID);
        expect(result).toEqual({ error: 'already_handled' });
    });

    it('denyQrRequest returns not_found for unknown qr_id', async () => {
        const result = await auth.denyQrRequest('nonexistent');
        expect(result).toEqual({ error: 'not_found' });
    });

    it('denyQrRequest returns already_handled if already denied', async () => {
        const { qr_id } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });
        await auth.denyQrRequest(qr_id);

        const result = await auth.denyQrRequest(qr_id);
        expect(result).toEqual({ error: 'already_handled' });
    });

    it('approveQrRequest returns expired for an expired request', async () => {
        const { qr_id } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });

        // Manually expire the row
        const past = new Date(Date.now() - 60000).toISOString();
        await proxy.env.DB.prepare(
            'UPDATE qr_login_requests SET expires_at = ? WHERE qr_id = ?'
        ).bind(past, qr_id).run();

        const result = await auth.approveQrRequest(qr_id, TEST_USER_ID);
        expect(result).toEqual({ error: 'expired' });
    });

    it('claimQrSession returns expired for an expired QR request and deletes it', async () => {
        const { qr_id, device_secret } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });

        // Manually expire the row
        const past = new Date(Date.now() - 60000).toISOString();
        await proxy.env.DB.prepare(
            'UPDATE qr_login_requests SET expires_at = ? WHERE qr_id = ?'
        ).bind(past, qr_id).run();

        const result = await auth.claimQrSession(qr_id, device_secret);
        expect(result.status).toBe('expired');

        // Row should be deleted
        const row = await proxy.env.DB.prepare(
            'SELECT * FROM qr_login_requests WHERE qr_id = ?'
        ).bind(qr_id).first();
        expect(row).toBeNull();
    });

    it('pending claim returns pending status', async () => {
        const { qr_id, device_secret } = await auth.createQrRequest({ ip: '1.2.3.4', ua: 'Test', country: 'US' });

        // Claim before approval
        const result = await auth.claimQrSession(qr_id, device_secret);
        expect(result.status).toBe('pending');
    });
});
