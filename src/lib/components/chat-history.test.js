import { describe, it, expect } from 'vitest';
import { buildChatHistory } from '../chat-history.js';

describe('buildChatHistory', () => {
    it('passes through regular user and assistant messages', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
        ];
        const history = buildChatHistory(messages);
        expect(history).toHaveLength(2);
        expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
        expect(history[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('preserves assistant messages with tool_calls', () => {
        const messages = [
            { role: 'user', content: 'Weekly summary' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_meals_last_7_days', arguments: '{}' }
                }],
                toolEvents: [{ name: 'get_meals_last_7_days', state: 'done' }]
            },
            { role: 'assistant', content: 'Here is your summary.' }
        ];
        const history = buildChatHistory(messages);
        expect(history).toHaveLength(3);
        expect(history[1].tool_calls).toBeDefined();
        expect(history[1].tool_calls[0].function.name).toBe('get_meals_last_7_days');
    });

    it('includes tool result messages', () => {
        const messages = [
            { role: 'user', content: 'Weekly summary' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_meals_last_7_days', arguments: '{}' } }]
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: JSON.stringify({ entries: [], count: 0 })
            },
            { role: 'assistant', content: 'No meals logged last week.' }
        ];
        const history = buildChatHistory(messages);
        expect(history).toHaveLength(4);
        expect(history[2].role).toBe('tool');
        expect(history[2].tool_call_id).toBe('call_1');
    });

    it('filters out system messages', () => {
        const messages = [
            { role: 'system', content: 'You are a nutrition assistant.' },
            { role: 'user', content: 'Hello' }
        ];
        const history = buildChatHistory(messages);
        expect(history).toHaveLength(1);
        expect(history[0].role).toBe('user');
    });

    it('strips extra properties like toolEvents and reasoning', () => {
        const messages = [
            { role: 'assistant', content: 'Hi', reasoning: 'thinking...', toolEvents: [], reasoningOpen: false }
        ];
        const history = buildChatHistory(messages);
        expect(history[0]).toEqual({ role: 'assistant', content: 'Hi' });
        expect(history[0].reasoning).toBeUndefined();
        expect(history[0].toolEvents).toBeUndefined();
    });
});
