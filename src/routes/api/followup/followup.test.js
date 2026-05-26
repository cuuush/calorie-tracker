import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
    applySchema, resetAll, seedSettings,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../tests/setup.js';
import { Storage } from '../../../lib/server/storage.js';
import { createToolCallResponse, createTextResponse } from '../../../tests/mocks/llm.js';

let proxy, storage;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
    const { getPlatformProxy } = await import('wrangler');
    proxy = await getPlatformProxy({ persist: false });
    await applySchema(proxy.env.DB);
    storage = new Storage(proxy.env);
});

beforeEach(async () => {
    await resetAll(proxy.env);
    await seedSettings(proxy.env.DB, TEST_USER_ID);
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

afterAll(async () => {
    await proxy.dispose();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEvent(body) {
    return {
        request: new Request('http://localhost/api/followup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: {
            env: { ...proxy.env, OPENROUTER_API_KEY: 'test-key' },
            context: { waitUntil: (p) => p?.then?.(() => {}).catch?.(() => {}) }
        }
    };
}

function mockFetchJSON(response) {
    globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('openrouter.ai')) {
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        throw new Error(`Unexpected fetch to: ${url}`);
    };
}

async function createTestEntry(overrides = {}) {
    const defaults = {
        id: 'followup-test-entry',
        meal_title: 'Chicken Salad',
        timestamp: '2026-05-26T12:00:00',
        items: [
            { name: 'Grilled Chicken', calories: 300, protein: 45, carbs: 0 },
            { name: 'Mixed Greens', calories: 50, protein: 3, carbs: 8 }
        ],
        total_calories: 350,
        total_protein: 48,
        total_carbs: 8,
        user_message: 'chicken salad for lunch',
        messages: [
            { role: 'system', content: 'You are a nutrition assistant.' },
            { role: 'user', content: 'chicken salad for lunch' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'log_meal', arguments: '{}' } }] }
        ],
        status: 'committed'
    };
    const entry = { ...defaults, ...overrides };
    await storage.saveEntry(entry, TEST_USER_ID);
    return entry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/followup', () => {
    it('returns 401 without a user', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: 'some-id',
            message: 'add rice'
        });
        event.locals.user = null;

        const response = await POST(event);
        expect(response.status).toBe(401);
    });

    it('returns 400 without entryId or messages', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'add rice'
        });

        const response = await POST(event);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('Either entryId or messages');
    });

    it('returns 404 for nonexistent entryId', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: 'nonexistent-entry',
            message: 'remove chicken'
        });

        const response = await POST(event);
        expect(response.status).toBe(404);
    });

    it('processes update_log tool call and returns updated entry', async () => {
        const entry = await createTestEntry();

        const newItems = [
            { name: 'Grilled Chicken', calories: 300, protein: 45, carbs: 0 },
            { name: 'Mixed Greens', calories: 50, protein: 3, carbs: 8 },
            { name: 'Brown Rice', calories: 200, protein: 5, carbs: 40 }
        ];

        mockFetchJSON(createToolCallResponse('update_log', {
            items: newItems
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'add brown rice'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.updatedEntry).not.toBeNull();
        expect(data.updatedEntry.items).toEqual(newItems);
        expect(data.updatedEntry.total_calories).toBe(550);   // 300+50+200
        expect(data.updatedEntry.total_protein).toBe(53);      // Math.round(45+3+5)
        expect(data.updatedEntry.total_carbs).toBe(48);        // 0+8+40

        // Verify the DB was updated
        const dbRow = await proxy.env.DB.prepare(
            'SELECT * FROM nutrition_entries WHERE id = ?'
        ).bind(entry.id).first();
        expect(dbRow.total_calories).toBe(550);
        expect(dbRow.total_protein).toBe(53);
        expect(dbRow.total_carbs).toBe(48);
        expect(JSON.parse(dbRow.items)).toEqual(newItems);
    });

    it('updates meal_title when provided in update_log', async () => {
        const entry = await createTestEntry();

        const newItems = [
            { name: 'Grilled Chicken', calories: 300, protein: 45, carbs: 0 },
            { name: 'Caesar Salad', calories: 180, protein: 6, carbs: 12 }
        ];

        mockFetchJSON(createToolCallResponse('update_log', {
            meal_title: 'Chicken Caesar Salad',
            items: newItems
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'actually it was a caesar salad'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.updatedEntry.meal_title).toBe('Chicken Caesar Salad');
    });

    it('returns tool message when update_log includes one', async () => {
        const entry = await createTestEntry();

        mockFetchJSON(createToolCallResponse('update_log', {
            items: [
                { name: 'Grilled Chicken', calories: 300, protein: 45, carbs: 0 },
                { name: 'Mixed Greens', calories: 50, protein: 3, carbs: 8 },
                { name: 'Peanut Butter (2 tbsp)', calories: 190, protein: 8, carbs: 6 }
            ],
            message: 'Assumed 2 tbsp of peanut butter.'
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'add peanut butter'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.content).toBe('Assumed 2 tbsp of peanut butter.');
    });

    it('returns text-only response when no update needed', async () => {
        const entry = await createTestEntry();

        mockFetchJSON(createTextResponse('Which salad dressing did you use?'));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'I had dressing'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.updatedEntry).toBeNull();
        expect(data.content).toBe('Which salad dressing did you use?');

        // Items should be unchanged in DB
        const dbRow = await proxy.env.DB.prepare(
            'SELECT * FROM nutrition_entries WHERE id = ?'
        ).bind(entry.id).first();
        expect(dbRow.total_calories).toBe(350);
        expect(dbRow.total_protein).toBe(48);
    });

    it('updates conversation in R2 after followup', async () => {
        const entry = await createTestEntry();

        mockFetchJSON(createTextResponse('Noted!'));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'just a note'
        });

        await POST(event);

        // Check the R2 blob for updated conversation
        const r2Obj = await proxy.env.IMAGES.get(`entry/${entry.id}.json`);
        expect(r2Obj).not.toBeNull();
        const blob = await r2Obj.json();
        const msgs = blob.conversation_messages;

        // Should contain original messages + user followup + assistant response
        const userFollowup = msgs.find(m => m.role === 'user' && m.content === 'just a note');
        expect(userFollowup).toBeDefined();
        const assistantReply = msgs.find(m => m.role === 'assistant' && m.content === 'Noted!');
        expect(assistantReply).toBeDefined();
    });

    it('clears pending_question after followup', async () => {
        const entry = await createTestEntry({
            id: 'followup-pending-q',
            pending_question: 'What kind of dressing?',
            status: 'awaiting_user'
        });

        mockFetchJSON(createToolCallResponse('update_log', {
            items: [
                { name: 'Grilled Chicken', calories: 300, protein: 45, carbs: 0 },
                { name: 'Mixed Greens with Ranch', calories: 100, protein: 3, carbs: 10 }
            ]
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: 'followup-pending-q',
            message: 'ranch dressing'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // pending_question should be cleared
        expect(data.updatedEntry.pending_question).toBeNull();

        // R2 blob should also reflect cleared pending_question
        const r2Obj = await proxy.env.IMAGES.get('entry/followup-pending-q.json');
        const blob = await r2Obj.json();
        expect(blob.pending_question).toBeNull();
    });

    it('promotes awaiting_user status to ready on update_log', async () => {
        const entry = await createTestEntry({
            id: 'followup-status-promote',
            status: 'awaiting_user'
        });

        mockFetchJSON(createToolCallResponse('update_log', {
            items: [{ name: 'Toast', calories: 100, protein: 3, carbs: 18 }]
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: 'followup-status-promote',
            message: 'just toast'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.updatedEntry.status).toBe('ready');
    });

    it('does not downgrade committed status on update_log', async () => {
        const entry = await createTestEntry({
            id: 'followup-no-downgrade',
            status: 'committed'
        });

        mockFetchJSON(createToolCallResponse('update_log', {
            items: [{ name: 'Salad', calories: 200, protein: 10, carbs: 15 }]
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: 'followup-no-downgrade',
            message: 'change to salad'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // Status should remain committed, not downgraded to ready
        expect(data.updatedEntry.status).toBe('committed');
    });

    it('works with providedMessages instead of entryId', async () => {
        const messages = [
            { role: 'user', content: 'I had a burger' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'log_meal', arguments: '{}' } }] }
        ];

        mockFetchJSON(createToolCallResponse('update_log', {
            items: [
                { name: 'Burger', calories: 500, protein: 30, carbs: 40 },
                { name: 'Fries', calories: 350, protein: 4, carbs: 45 }
            ],
            meal_title: 'Burger & Fries'
        }));

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            messages,
            message: 'add fries'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.updatedEntry).not.toBeNull();
        expect(data.updatedEntry.items).toHaveLength(2);
        expect(data.updatedEntry.total_calories).toBe(850);
        expect(data.updatedEntry.meal_title).toBe('Burger & Fries');
    });

    it('sends correct request to OpenRouter', async () => {
        const entry = await createTestEntry();
        let capturedBody = null;

        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                capturedBody = JSON.parse(opts.body);
                return new Response(JSON.stringify(createTextResponse('OK')), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'test message'
        });

        await POST(event);

        expect(capturedBody).not.toBeNull();
        // Should have Authorization header
        expect(capturedBody.messages).toBeDefined();
        expect(capturedBody.tools).toBeDefined();
        expect(capturedBody.tools[0].function.name).toBe('update_log');
        // System prompt should be the edit prompt (overwritten)
        const systemMsg = capturedBody.messages.find(m => m.role === 'system');
        expect(systemMsg).toBeDefined();
        expect(systemMsg.content).toContain('editing');
        // User's followup message should be the last user message
        const userMsgs = capturedBody.messages.filter(m => m.role === 'user');
        expect(userMsgs[userMsgs.length - 1].content).toBe('test message');
    });

    it('returns reasoning from the LLM response', async () => {
        const entry = await createTestEntry();

        globalThis.fetch = async (url) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                return new Response(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: 'Here you go.',
                            reasoning: 'The user wants a simple text response.'
                        },
                        finish_reason: 'stop'
                    }]
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: entry.id,
            message: 'what do you think?'
        });

        const response = await POST(event);
        const data = await response.json();
        expect(data.reasoning).toBe('The user wants a simple text response.');
    });
});
