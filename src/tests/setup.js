import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TEST_USER_ID = 'test-user-123';
export const TEST_USER_EMAIL = 'test@example.com';

export async function getTestPlatform() {
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy({ persist: false });
    return proxy;
}

export async function applySchema(db) {
    const schemaPath = resolve(__dirname, '../../schema.sql');
    const raw = readFileSync(schemaPath, 'utf-8');
    const schema = raw.replace(/--.*$/gm, '').trim();
    const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
        await db.prepare(stmt).run();
    }
}

export async function clearAllTables(db) {
    const tables = [
        'nutrition_entries',
        'chat_conversations',
        'user_settings',
        'sessions',
        'verification_tokens',
        'qr_login_requests',
        'users'
    ];
    for (const table of tables) {
        await db.prepare(`DELETE FROM ${table}`).run();
    }
}

export async function seedTestUser(db) {
    await db.prepare(`
        INSERT OR IGNORE INTO users (id, email, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(TEST_USER_ID, TEST_USER_EMAIL).run();
}

export async function resetDatabase(db) {
    await clearAllTables(db);
    await seedTestUser(db);
}

export async function clearR2(images) {
    const listed = await images.list();
    for (const obj of listed.objects) {
        await images.delete(obj.key);
    }
}

export async function clearKV(cache) {
    const listed = await cache.list();
    for (const key of listed.keys) {
        await cache.delete(key.name);
    }
}

export async function resetAll(env) {
    await resetDatabase(env.DB);
    await clearR2(env.IMAGES);
    await clearKV(env.CACHE);
}

export async function seedSettings(db, userId, settings = {}) {
    const defaults = {
        weight: 180,
        weight_unit: 'lbs',
        height: 72,
        height_unit: 'in',
        age: 30,
        gender: 'male',
        activity_level: 'moderate',
        maintenance_calories: 2200,
        protein_goal: 150,
        protein_focused_mode: 0,
        goals: 'lose fat, build muscle'
    };
    const s = { ...defaults, ...settings };
    await db.prepare(`
        INSERT OR REPLACE INTO user_settings (
            user_id, weight, weight_unit, height, height_unit, age, gender,
            activity_level, maintenance_calories, protein_goal, protein_focused_mode, goals
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        userId, s.weight, s.weight_unit, s.height, s.height_unit,
        s.age, s.gender, s.activity_level, s.maintenance_calories,
        s.protein_goal, s.protein_focused_mode, s.goals
    ).run();
}

export async function seedEntry(db, userId, entry) {
    await db.prepare(`
        INSERT INTO nutrition_entries (
            id, user_id, timestamp, user_message, meal_title,
            total_calories, total_protein, total_carbs, items, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        entry.id,
        userId,
        entry.timestamp,
        entry.user_message || null,
        entry.meal_title || null,
        entry.total_calories || 0,
        entry.total_protein || 0,
        entry.total_carbs || 0,
        JSON.stringify(entry.items || []),
        entry.status || 'committed'
    ).run();
}
