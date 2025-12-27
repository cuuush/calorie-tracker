export class Auth {
    constructor(env) {
        this.db = env.DB;
        this.resendApiKey = env.RESEND_API_KEY;
        this.cache = env.CACHE; // KV for caching sessions
    }

    // Generate cryptographically secure random token (32 bytes = 64 hex chars)
    generateToken() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // Validate email format
    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    // Send magic link via Resend
    async sendMagicLink(email, request) {
        if (!this.isValidEmail(email)) {
            throw new Error('Invalid email format');
        }

        // Generate verification token
        const token = this.generateToken();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

        // Store token in database
        await this.db.prepare(`
            INSERT INTO verification_tokens (token, email, expires_at)
            VALUES (?, ?, ?)
        `).bind(token, email.toLowerCase(), expiresAt.toISOString()).run();

        // Generate magic link
        const url = new URL(request.url);
        const magicLink = `${url.protocol}//${url.host}/auth/verify?token=${token}`;

        // Send email via Resend
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.resendApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'Calorie Tracker <tracker@robot.cuuush.com>',
                to: [email],
                subject: 'Sign in to Tracker',
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    </head>
                    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background-color: #000000; color: #ffffff;">
                        <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                            <h1 style="font-size: 24px; font-weight: 600; letter-spacing: 2px; margin-bottom: 30px;">CALORIE TRACKER</h1>
                            <h2 style="font-size: 18px; font-weight: 400; margin-bottom: 20px;">Sign in to your account</h2>
                            <p style="font-size: 14px; color: #888888; margin-bottom: 30px;">
                                Click the button below to sign in. This link expires in 15 minutes.
                            </p>
                            <a href="${magicLink}" style="display: inline-block; background-color: #ffffff; color: #000000; padding: 16px 32px; text-decoration: none; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; border-radius: 4px;">
                                Sign In
                            </a>
                            <p style="font-size: 12px; color: #666666; margin-top: 40px;">
                                If you didn't request this email, you can safely ignore it.
                            </p>
                            <p style="font-size: 12px; color: #444444; margin-top: 20px;">
                                Or copy and paste this link:<br>
                                <span style="color: #888888; word-break: break-all;">${magicLink}</span>
                            </p>
                        </div>
                    </body>
                    </html>
                `
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Resend API error:', errorText);
            throw new Error('Failed to send email');
        }

        return { success: true };
    }

    // Verify magic link token and create session
    async verifyToken(token) {
        if (!token) {
            return null;
        }

        // Check if token exists and is valid
        const verificationToken = await this.db.prepare(`
            SELECT * FROM verification_tokens
            WHERE token = ? AND used = 0
        `).bind(token).first();

        if (!verificationToken) {
            return null;
        }

        // Check if token has expired
        const now = new Date();
        const expiresAt = new Date(verificationToken.expires_at);
        if (now > expiresAt) {
            return null;
        }

        // Mark token as used
        await this.db.prepare(`
            UPDATE verification_tokens
            SET used = 1
            WHERE token = ?
        `).bind(token).run();

        // Get or create user
        const email = verificationToken.email.toLowerCase();
        let user = await this.db.prepare('SELECT * FROM users WHERE email = ?')
            .bind(email).first();

        if (!user) {
            // Create new user
            const userId = crypto.randomUUID();
            await this.db.prepare(`
                INSERT INTO users (id, email, created_at, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).bind(userId, email).run();

            user = { id: userId, email };
        }

        // Create session
        const sessionToken = this.generateToken();
        const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

        await this.db.prepare(`
            INSERT INTO sessions (token, user_id, expires_at)
            VALUES (?, ?, ?)
        `).bind(sessionToken, user.id, sessionExpiresAt.toISOString()).run();

        return {
            sessionToken,
            user
        };
    }

    // Validate session and refresh expiry (rolling 30 days)
    async validateSession(token) {
        if (!token) {
            return null;
        }

        // Check KV cache first (FAST!)
        const cacheKey = `session:${token}`;
        if (this.cache) {
            const cached = await this.cache.get(cacheKey, 'json');
            if (cached) {
                // Cache hit - return userId without hitting D1
                return cached.userId;
            }
        }

        // Cache miss - validate from D1
        const session = await this.db.prepare(`
            SELECT * FROM sessions WHERE token = ?
        `).bind(token).first();

        if (!session) {
            return null;
        }

        // Check if session has expired
        const now = new Date();
        const expiresAt = new Date(session.expires_at);
        if (now > expiresAt) {
            // Delete expired session
            await this.db.prepare('DELETE FROM sessions WHERE token = ?')
                .bind(token).run();
            // Also clear cache if it exists
            if (this.cache) {
                await this.cache.delete(cacheKey);
            }
            return null;
        }

        // Only refresh session expiry if it's been > 1 hour since last update
        // (avoids D1 writes on every request)
        const lastUsed = session.last_used_at ? new Date(session.last_used_at) : new Date(0);
        const hoursSinceLastUpdate = (now - lastUsed) / (1000 * 60 * 60);

        if (hoursSinceLastUpdate > 1) {
            const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await this.db.prepare(`
                UPDATE sessions
                SET last_used_at = CURRENT_TIMESTAMP,
                    expires_at = ?
                WHERE token = ?
            `).bind(newExpiresAt.toISOString(), token).run();
        }

        // Cache the session for 10 minutes (short TTL for security)
        // If session is revoked, it will be invalid within 10 min
        if (this.cache) {
            await this.cache.put(cacheKey, JSON.stringify({ userId: session.user_id }), {
                expirationTtl: 600 // 10 minutes
            });
        }

        return session.user_id;
    }

    // Delete session (logout)
    async deleteSession(token) {
        if (!token) {
            return;
        }

        await this.db.prepare('DELETE FROM sessions WHERE token = ?')
            .bind(token).run();

        // Invalidate cache on logout (CRITICAL for security!)
        const cacheKey = `session:${token}`;
        if (this.cache) {
            await this.cache.delete(cacheKey);
        }
    }

    // Cleanup expired tokens and sessions (should be called periodically)
    async cleanupExpired() {
        const now = new Date().toISOString();

        // Delete expired verification tokens
        await this.db.prepare(`
            DELETE FROM verification_tokens
            WHERE expires_at < ? OR used = 1
        `).bind(now).run();

        // Delete expired sessions
        await this.db.prepare(`
            DELETE FROM sessions
            WHERE expires_at < ?
        `).bind(now).run();
    }

    // Get user by ID
    async getUser(userId) {
        return await this.db.prepare('SELECT id, email, created_at FROM users WHERE id = ?')
            .bind(userId).first();
    }
}
