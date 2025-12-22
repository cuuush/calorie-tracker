export class Storage {
    constructor(env) {
        this.db = env.DB;
        this.images = env.IMAGES; // R2 Bucket
    }

    async saveEntry(entry) {
        if (!this.db || !this.images) {
            throw new Error('Database or Storage not configured');
        }

        const entryId = entry.id || `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const timestamp = new Date().toISOString();

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

        // 2. Save metadata to D1
        // items are also saved in D1 for quick access/indexing if needed, but strict details are in R2
        await this.db.prepare(`
      INSERT INTO nutrition_entries (
        id, timestamp, user_message, meal_title, total_calories, total_protein, total_carbs, items
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
            entryId,
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

    async getHistory(limit = 100) {
        if (!this.db) return [];

        const { results } = await this.db.prepare(`
      SELECT * FROM nutrition_entries 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).bind(limit).all();

        return results.map(row => ({
            ...row,
            items: row.items ? JSON.parse(row.items) : []
        }));
    }

    async getEntryDetails(id) {
        const meta = await this.db.prepare('SELECT * FROM nutrition_entries WHERE id = ?').bind(id).first();
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

    async deleteEntry(id) {
        await this.db.prepare('DELETE FROM nutrition_entries WHERE id = ?').bind(id).run();
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

    async getUserSettings() {
        if (!this.db) return null;
        return await this.db.prepare('SELECT * FROM user_settings WHERE id = 1').first();
    }

    async saveUserSettings(settings) {
        if (!this.db) throw new Error('Database not configured');

        const { weight, weight_unit, height, height_unit, age, gender, activity_level, maintenance_calories } = settings;

        await this.db.prepare(`
            INSERT INTO user_settings (
                id, weight, weight_unit, height, height_unit, age, gender, activity_level, maintenance_calories, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                weight = excluded.weight,
                weight_unit = excluded.weight_unit,
                height = excluded.height,
                height_unit = excluded.height_unit,
                age = excluded.age,
                gender = excluded.gender,
                activity_level = excluded.activity_level,
                maintenance_calories = excluded.maintenance_calories,
                updated_at = CURRENT_TIMESTAMP
        `).bind(
            weight || null,
            weight_unit || 'lbs',
            height || null,
            height_unit || 'in',
            age || null,
            gender || null,
            activity_level || null,
            maintenance_calories || null
        ).run();

        return await this.getUserSettings();
    }
}
