export class Storage {
    constructor(env) {
        this.db = env.DB;
        this.images = env.IMAGES; // R2 Bucket
        this.cache = env.CACHE; // KV Namespace for caching
    }

    async saveEntry(entry, userId) {
        if (!this.db || !this.images) {
            throw new Error('Database or Storage not configured');
        }

        if (!userId) {
            throw new Error('userId is required');
        }

        const entryId = entry.id || `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        // Use client-provided timestamp (local time format) or fallback to UTC
        const timestamp = entry.timestamp || (() => {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
        })();

        const status = entry.status || 'committed';

        // 1. Save large content to R2
        const largeContent = {
            items: entry.items || [],
            reasoning: entry.reasoning || null,
            reasoning_details: entry.reasoning_details || null,
            conversation_messages: entry.messages || [],
            raw_response: entry.raw_response || null,
            image_keys: entry.image_keys || [],
            audio_key: entry.audio_key || null,
            pending_question: entry.pending_question || null
        };

        await this.images.put(`entry/${entryId}.json`, JSON.stringify(largeContent), {
            httpMetadata: { contentType: 'application/json' }
        });

        // 2. Save metadata to D1 (UPSERT - handles both insert and update)
        // items are also saved in D1 for quick access/indexing if needed, but strict details are in R2
        await this.db.prepare(`
      INSERT INTO nutrition_entries (
        id, user_id, timestamp, user_message, meal_title, total_calories, total_protein, total_carbs, items, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        timestamp = excluded.timestamp,
        meal_title = excluded.meal_title,
        total_calories = excluded.total_calories,
        total_protein = excluded.total_protein,
        total_carbs = excluded.total_carbs,
        items = excluded.items,
        status = excluded.status
    `).bind(
            entryId,
            userId,
            timestamp,
            entry.user_message || null,
            entry.meal_title || null,
            entry.total_calories || 0,
            entry.total_protein || 0,
            entry.total_carbs || 0,
            JSON.stringify(entry.items || []),
            status
        ).run();

        return { ...entry, id: entryId, timestamp, status };
    }

    async setEntryStatus(id, userId, status) {
        if (!userId) throw new Error('userId is required');
        await this.db
            .prepare('UPDATE nutrition_entries SET status = ? WHERE id = ? AND user_id = ?')
            .bind(status, id, userId)
            .run();
    }

    async getHistory(userId, limit = 100) {
        if (!this.db) return [];

        if (!userId) {
            throw new Error('userId is required');
        }

        const { results } = await this.db.prepare(`
      SELECT * FROM nutrition_entries
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(userId, limit).all();

        const rows = results.map(row => ({
            ...row,
            status: row.status || 'committed',
            items: row.items ? JSON.parse(row.items) : []
        }));

        // Hydrate pending_question for non-committed entries so HistoryView can surface it.
        const pending = rows.filter((r) => r.status !== 'committed');
        if (pending.length > 0 && this.images) {
            await Promise.all(
                pending.map(async (row) => {
                    try {
                        const object = await this.images.get(`entry/${row.id}.json`);
                        if (!object) return;
                        const blob = await object.json();
                        if (blob.pending_question) row.pending_question = blob.pending_question;
                    } catch {
                        // Best-effort; missing blob just leaves badge without question text.
                    }
                })
            );
        }

        return rows;
    }

    async getEntriesBetween(userId, startISO, endISO) {
        if (!this.db) return [];
        if (!userId) throw new Error('userId is required');

        const { results } = await this.db.prepare(`
            SELECT id, timestamp, meal_title, total_calories, total_protein, total_carbs, items
            FROM nutrition_entries
            WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).bind(userId, startISO, endISO).all();

        return results.map(r => ({
            ...r,
            items: r.items ? JSON.parse(r.items) : []
        }));
    }

    async getEntryDetails(id, userId) {
        if (!userId) {
            throw new Error('userId is required');
        }

        const meta = await this.db.prepare('SELECT * FROM nutrition_entries WHERE id = ? AND user_id = ?').bind(id, userId).first();
        if (!meta) return null;

        const object = await this.images.get(`entry/${id}.json`);
        let content = {};

        if (object) {
            content = await object.json();
        }

        return {
            ...meta,
            ...content,
            status: meta.status || 'committed',
            items: content.items || (meta.items ? JSON.parse(meta.items) : [])
        };
    }

    async deleteEntry(id, userId) {
        if (!userId) {
            throw new Error('userId is required');
        }

        // Look up pending image/audio keys before we drop the blob so we can clean R2.
        let keysToDelete = [];
        try {
            const object = await this.images.get(`entry/${id}.json`);
            if (object) {
                const blob = await object.json();
                if (Array.isArray(blob.image_keys)) keysToDelete.push(...blob.image_keys);
                if (blob.audio_key) keysToDelete.push(blob.audio_key);
            }
        } catch {
            // Best-effort cleanup; proceed with DB delete regardless.
        }

        await this.db.prepare('DELETE FROM nutrition_entries WHERE id = ? AND user_id = ?').bind(id, userId).run();
        await this.images.delete(`entry/${id}.json`);

        for (const k of keysToDelete) {
            try { await this.images.delete(k); } catch { /* ignore */ }
        }

        return true;
    }

    async updateConversation(id, messages, reasoning, reasoning_details, extra = {}) {
        const object = await this.images.get(`entry/${id}.json`);
        if (!object) throw new Error('Entry not found in storage');

        const content = await object.json();

        content.conversation_messages = messages;
        if (reasoning) content.reasoning = reasoning;
        if (reasoning_details) content.reasoning_details = reasoning_details;
        // Allow callers to clear or set pending_question / image_keys via extra.
        if ('pending_question' in extra) content.pending_question = extra.pending_question;
        if ('image_keys' in extra) content.image_keys = extra.image_keys;
        if ('audio_key' in extra) content.audio_key = extra.audio_key;

        await this.images.put(`entry/${id}.json`, JSON.stringify(content), {
            httpMetadata: { contentType: 'application/json' }
        });
    }

    async getUserSettings(userId) {
        if (!this.db) return null;

        if (!userId) {
            throw new Error('userId is required');
        }

        // Try to get from KV cache first (settings change rarely!)
        const cacheKey = `settings:${userId}`;
        if (this.cache) {
            const cached = await this.cache.get(cacheKey, 'json');
            if (cached) {
                return cached;
            }
        }

        // Cache miss - query database
        const settings = await this.db.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first();

        // Store in cache for 24 hours (settings rarely change)
        if (this.cache && settings) {
            await this.cache.put(cacheKey, JSON.stringify(settings), {
                expirationTtl: 86400 // 24 hours
            });
        }

        return settings;
    }

    async saveUserSettings(settings, userId) {
        if (!this.db) throw new Error('Database not configured');

        if (!userId) {
            throw new Error('userId is required');
        }

        const { weight, weight_unit, height, height_unit, age, gender, activity_level, maintenance_calories, protein_goal, protein_focused_mode, goals } = settings;

        await this.db.prepare(`
            INSERT INTO user_settings (
                user_id, weight, weight_unit, height, height_unit, age, gender, activity_level, maintenance_calories, protein_goal, protein_focused_mode, goals, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                weight = excluded.weight,
                weight_unit = excluded.weight_unit,
                height = excluded.height,
                height_unit = excluded.height_unit,
                age = excluded.age,
                gender = excluded.gender,
                activity_level = excluded.activity_level,
                maintenance_calories = excluded.maintenance_calories,
                protein_goal = excluded.protein_goal,
                protein_focused_mode = excluded.protein_focused_mode,
                goals = excluded.goals,
                updated_at = CURRENT_TIMESTAMP
        `).bind(
            userId,
            weight || null,
            weight_unit || 'lbs',
            height || null,
            height_unit || 'in',
            age || null,
            gender || null,
            activity_level || null,
            maintenance_calories || null,
            protein_goal || 150,
            protein_focused_mode || 0,
            goals || null
        ).run();

        // Invalidate cache when settings are updated
        const cacheKey = `settings:${userId}`;
        if (this.cache) {
            await this.cache.delete(cacheKey);
        }

        return await this.getUserSettings(userId);
    }

    // --- Chat conversations ---

    async createChatConversation(userId, title) {
        if (!userId) throw new Error('userId is required');
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        await this.db.prepare(`
            INSERT INTO chat_conversations (id, user_id, title, messages, created_at, updated_at)
            VALUES (?, ?, ?, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(id, userId, title || null).run();
        return id;
    }

    async saveChatConversation(id, userId, messages, title = null) {
        if (!userId) throw new Error('userId is required');
        if (!id) throw new Error('conversation id is required');
        const payload = JSON.stringify(messages || []);
        await this.db.prepare(`
            INSERT INTO chat_conversations (id, user_id, title, messages, created_at, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                messages = excluded.messages,
                title = COALESCE(excluded.title, chat_conversations.title),
                updated_at = CURRENT_TIMESTAMP
            WHERE chat_conversations.user_id = excluded.user_id
        `).bind(id, userId, title, payload).run();
    }

    async listChatConversations(userId, limit = 50) {
        if (!userId) throw new Error('userId is required');
        const { results } = await this.db.prepare(`
            SELECT id, title, updated_at, created_at
            FROM chat_conversations
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
        `).bind(userId, limit).all();
        return results;
    }

    async getChatConversation(id, userId) {
        if (!userId) throw new Error('userId is required');
        const row = await this.db.prepare(`
            SELECT id, title, messages, updated_at, created_at
            FROM chat_conversations
            WHERE id = ? AND user_id = ?
        `).bind(id, userId).first();
        if (!row) return null;
        return {
            ...row,
            messages: row.messages ? JSON.parse(row.messages) : []
        };
    }

    async deleteChatConversation(id, userId) {
        if (!userId) throw new Error('userId is required');
        await this.db.prepare(`
            DELETE FROM chat_conversations WHERE id = ? AND user_id = ?
        `).bind(id, userId).run();
        return true;
    }

    async getStats(userId, clientDate = null, tz = 'UTC') {
        if (!this.db) return null;

        if (!userId) {
            throw new Error('userId is required');
        }

        // Determine today's YYYY-MM-DD string. clientDate (legacy query param) wins
        // when provided; otherwise compute from the user's timezone via Intl.
        let todayYmd;
        if (clientDate) {
            // clientDate format: "YYYY-MM-DD" — already local to the user
            todayYmd = clientDate.split('T')[0];
        } else {
            // en-CA gives YYYY-MM-DD natively
            todayYmd = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(new Date());
        }
        const todayStart = `${todayYmd}T00:00:00`;
        const todayEnd = `${todayYmd}T23:59:59`;

        // Get start of week (Sunday) — derive from todayYmd treated as a calendar date
        const [yy, mm, dd] = todayYmd.split('-').map(Number);
        const todayDate = new Date(yy, mm - 1, dd);
        const startOfWeek = new Date(todayDate);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        const weekYear = startOfWeek.getFullYear();
        const weekMonth = String(startOfWeek.getMonth() + 1).padStart(2, '0');
        const weekDay = String(startOfWeek.getDate()).padStart(2, '0');
        const weekStart = `${weekYear}-${weekMonth}-${weekDay}T00:00:00`;

        // Get today's entries for meal breakdown
        const { results: todayEntries } = await this.db.prepare(`
            SELECT timestamp, total_calories, total_protein
            FROM nutrition_entries
            WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
        `).bind(userId, todayStart, todayEnd).all();

        // Get this week's entries for weekly chart
        const { results: weekEntries } = await this.db.prepare(`
            SELECT timestamp, total_calories, total_protein
            FROM nutrition_entries
            WHERE user_id = ? AND timestamp >= ?
            ORDER BY timestamp DESC
        `).bind(userId, weekStart).all();

        // Calculate today's totals and meal groups
        const groups = { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 };
        const proteinGroups = { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 };
        let todayTotal = 0;
        let todayProtein = 0;

        todayEntries.forEach(entry => {
            // Parse hours directly from timestamp string (format: "YYYY-MM-DDTHH:MM:SS")
            const timePart = entry.timestamp.split('T')[1] || '00:00:00';
            const h = parseInt(timePart.split(':')[0], 10);
            let mealType;
            if (h >= 4 && h < 11) mealType = 'BREAKFAST';
            else if (h >= 11 && h < 16) mealType = 'LUNCH';
            else if (h >= 16 && h < 22) mealType = 'DINNER';
            else mealType = 'SNACK';

            groups[mealType] += entry.total_calories;
            proteinGroups[mealType] += entry.total_protein || 0;
            todayTotal += entry.total_calories;
            todayProtein += entry.total_protein || 0;
        });

        // Calculate weekly data
        const weeklyData = [0, 0, 0, 0, 0, 0, 0];
        const weeklyProteinData = [0, 0, 0, 0, 0, 0, 0];

        weekEntries.forEach(entry => {
            // Parse date directly from timestamp string (format: "YYYY-MM-DDTHH:MM:SS")
            const datePart = entry.timestamp.split('T')[0];
            const [year, month, day] = datePart.split('-').map(Number);
            const d = new Date(year, month - 1, day);
            const dayOfWeek = d.getDay();
            weeklyData[dayOfWeek] += entry.total_calories;
            weeklyProteinData[dayOfWeek] += entry.total_protein || 0;
        });

        return {
            todayTotal,
            todayProtein,
            groups,
            proteinGroups,
            weeklyData,
            weeklyProteinData
        };
    }
}
