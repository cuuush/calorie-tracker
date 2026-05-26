import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../../../tests/setup.js';
import { Storage } from '../../../../../lib/server/storage.js';

let proxy, storage;

beforeAll(async () => {
    const { getPlatformProxy } = await import('wrangler');
    proxy = await getPlatformProxy({ persist: false });
    await applySchema(proxy.env.DB);
    storage = new Storage(proxy.env);
});

beforeEach(async () => {
    await resetAll(proxy.env);
});

afterAll(async () => {
    await proxy.dispose();
});

function createGetEvent(id, user = { id: TEST_USER_ID, email: TEST_USER_EMAIL }) {
    return {
        request: new Request(`http://localhost/api/chat/conversations/${id}`, {
            method: 'GET'
        }),
        params: { id },
        locals: {
            user,
            storage
        },
        platform: {
            env: { ...proxy.env }
        }
    };
}

function createDeleteEvent(id, user = { id: TEST_USER_ID, email: TEST_USER_EMAIL }) {
    return {
        request: new Request(`http://localhost/api/chat/conversations/${id}`, {
            method: 'DELETE'
        }),
        params: { id },
        locals: {
            user,
            storage
        },
        platform: {
            env: { ...proxy.env }
        }
    };
}

describe('Conversation [id] GET', () => {
    it('returns 401 without user', async () => {
        const { GET } = await import('./+server.js');
        const event = createGetEvent('some-id');
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('returns 404 for nonexistent conversation', async () => {
        const { GET } = await import('./+server.js');
        const event = createGetEvent('nonexistent-id-12345');

        const response = await GET(event);
        expect(response.status).toBe(404);
        const data = await response.json();
        expect(data.error).toBe('Not found');
    });

    it('returns conversation with messages', async () => {
        const { GET } = await import('./+server.js');

        // Create and populate a conversation
        const convoId = await storage.createChatConversation(TEST_USER_ID, 'Test Convo');
        const messages = [
            { role: 'user', content: 'How many calories in an apple?' },
            { role: 'assistant', content: 'A medium apple has about 95 calories.' }
        ];
        await storage.saveChatConversation(convoId, TEST_USER_ID, messages, 'Test Convo');

        const event = createGetEvent(convoId);
        const response = await GET(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.id).toBe(convoId);
        expect(data.title).toBe('Test Convo');
        expect(data.messages).toBeDefined();
        expect(Array.isArray(data.messages)).toBe(true);
        expect(data.messages.length).toBe(2);
        expect(data.messages[0].role).toBe('user');
        expect(data.messages[0].content).toBe('How many calories in an apple?');
        expect(data.messages[1].role).toBe('assistant');
        expect(data.messages[1].content).toContain('95 calories');
    });

    it('returns conversation with empty messages', async () => {
        const { GET } = await import('./+server.js');

        const convoId = await storage.createChatConversation(TEST_USER_ID, 'Empty Convo');

        const event = createGetEvent(convoId);
        const response = await GET(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.id).toBe(convoId);
        expect(data.messages).toEqual([]);
    });

    it('returns 404 for conversation owned by another user', async () => {
        const { GET } = await import('./+server.js');

        // Create conversation as another user
        const otherUserId = 'other-user-789';
        await proxy.env.DB.prepare(`
            INSERT OR IGNORE INTO users (id, email, created_at, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(otherUserId, 'other@example.com').run();

        const convoId = await storage.createChatConversation(otherUserId, 'Secret Chat');
        await storage.saveChatConversation(convoId, otherUserId, [
            { role: 'user', content: 'private stuff' }
        ], 'Secret Chat');

        // Try to access as our test user
        const event = createGetEvent(convoId);
        const response = await GET(event);
        expect(response.status).toBe(404);
    });

    it('returns conversation with tool_calls and tool messages', async () => {
        const { GET } = await import('./+server.js');

        const convoId = await storage.createChatConversation(TEST_USER_ID, 'Tool Convo');
        const messages = [
            { role: 'user', content: 'What did I eat today?' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_meals_today', arguments: '{}' }
                }]
            },
            { role: 'tool', tool_call_id: 'call_abc', content: '{"entries":[],"count":0}' },
            { role: 'assistant', content: 'You haven\'t logged any meals today.' }
        ];
        await storage.saveChatConversation(convoId, TEST_USER_ID, messages, 'Tool Convo');

        const event = createGetEvent(convoId);
        const response = await GET(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.messages.length).toBe(4);
        expect(data.messages[1].tool_calls).toBeDefined();
        expect(data.messages[1].tool_calls[0].function.name).toBe('get_meals_today');
        expect(data.messages[2].role).toBe('tool');
        expect(data.messages[2].tool_call_id).toBe('call_abc');
    });
});

describe('Conversation [id] DELETE', () => {
    it('returns 401 without user', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent('some-id');
        event.locals.user = null;

        const response = await DELETE(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('successful deletion returns ok', async () => {
        const { DELETE } = await import('./+server.js');

        const convoId = await storage.createChatConversation(TEST_USER_ID, 'To Delete');
        await storage.saveChatConversation(convoId, TEST_USER_ID, [
            { role: 'user', content: 'This will be deleted' }
        ], 'To Delete');

        // Verify it exists first
        const before = await storage.getChatConversation(convoId, TEST_USER_ID);
        expect(before).not.toBeNull();

        const event = createDeleteEvent(convoId);
        const response = await DELETE(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.ok).toBe(true);

        // Verify it's gone
        const after = await storage.getChatConversation(convoId, TEST_USER_ID);
        expect(after).toBeNull();
    });

    it('deleting nonexistent conversation still returns ok (idempotent)', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent('nonexistent-id-99999');

        const response = await DELETE(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.ok).toBe(true);
    });

    it('cannot delete another user\'s conversation', async () => {
        const { DELETE, GET } = await import('./+server.js');

        // Create conversation as another user
        const otherUserId = 'other-user-del-123';
        await proxy.env.DB.prepare(`
            INSERT OR IGNORE INTO users (id, email, created_at, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(otherUserId, 'other-del@example.com').run();

        const convoId = await storage.createChatConversation(otherUserId, 'Other Chat');

        // Try to delete as our test user - the SQL has WHERE user_id = ? so it won't match
        const event = createDeleteEvent(convoId);
        const response = await DELETE(event);
        expect(response.status).toBe(200); // returns ok but doesn't actually delete

        // Verify it still exists for the other user
        const still = await storage.getChatConversation(convoId, otherUserId);
        expect(still).not.toBeNull();
    });
});
