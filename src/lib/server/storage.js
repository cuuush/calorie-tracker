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
        const timestamp = entry.timestamp || new Date().toISOString();

        // 1. Save large content to R2
        const largeContent = {
            items: entry.items || [],
            reasoning: entry.reasoning || null,
            reasoning_details: entry.reasoning_details || null,
            conversation_messages: entry.messages || [],
            raw_response: entry.raw_response || null
        };

        await this.images.put(`entry/${entryId}.json`, JSON.stringify(largeContent), {
            httpMetadata: { contentType: 'application/json' }
        });

        // 2. Save metadata to D1 (UPSERT - handles both insert and update)
        // items are also saved in D1 for quick access/indexing if needed, but strict details are in R2
        await this.db.prepare(`
      INSERT INTO nutrition_entries (
        id, user_id, timestamp, user_message, meal_title, total_calories, total_protein, total_carbs, items
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        meal_title = excluded.meal_title,
        total_calories = excluded.total_calories,
        total_protein = excluded.total_protein,
        total_carbs = excluded.total_carbs,
        items = excluded.items
    `).bind(
            entryId,
            userId,
            timestamp,
            entry.user_message || null,
            entry.meal_title || null,
            entry.total_calories || 0,
            entry.total_protein || 0,
            entry.total_carbs || 0,
            JSON.stringify(entry.items || [])
        ).run();

        return { ...entry, id: entryId, timestamp };
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

        return results.map(row => ({
            ...row,
            items: row.items ? JSON.parse(row.items) : []
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
            items: content.items || (meta.items ? JSON.parse(meta.items) : [])
        };
    }

    async deleteEntry(id, userId) {
        if (!userId) {
            throw new Error('userId is required');
        }

        await this.db.prepare('DELETE FROM nutrition_entries WHERE id = ? AND user_id = ?').bind(id, userId).run();
        await this.images.delete(`entry/${id}.json`);
        return true;
    }

    async updateConversation(id, messages, reasoning, reasoning_details) {
        const object = await this.images.get(`entry/${id}.json`);
        if (!object) throw new Error('Entry not found in storage');

        const content = await object.json();

        content.conversation_messages = messages;
        if (reasoning) content.reasoning = reasoning;
        if (reasoning_details) content.reasoning_details = reasoning_details;

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

        const { weight, weight_unit, height, height_unit, age, gender, activity_level, maintenance_calories, protein_goal, protein_focused_mode } = settings;

        await this.db.prepare(`
            INSERT INTO user_settings (
                user_id, weight, weight_unit, height, height_unit, age, gender, activity_level, maintenance_calories, protein_goal, protein_focused_mode, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
            protein_focused_mode || 0
        ).run();

        // Invalidate cache when settings are updated
        const cacheKey = `settings:${userId}`;
        if (this.cache) {
            await this.cache.delete(cacheKey);
        }

        return await this.getUserSettings(userId);
    }

    async getStats(userId) {
        if (!this.db) return null;

        if (!userId) {
            throw new Error('userId is required');
        }

        // Get today's date boundaries in ISO format
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();

        // Get start of week (Sunday)
        const startOfWeek = new Date(now);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        const weekStart = startOfWeek.toISOString();

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
            const h = new Date(entry.timestamp).getHours();
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
            const d = new Date(entry.timestamp);
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
