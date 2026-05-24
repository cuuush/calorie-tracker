import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOpenRouter } from './ai.js';

describe('callOpenRouter', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('returns canned log_meal response in debug mode', async () => {
        const env = { DEBUG_MODE: 'true', OPENROUTER_API_KEY: 'test' };
        const tools = [{ function: { name: 'log_meal' } }];

        const result = await callOpenRouter(env, [], tools);
        expect(result.choices[0].message.tool_calls[0].function.name).toBe('log_meal');
        expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    it('returns canned text response in debug mode when no matching tools', async () => {
        const env = { DEBUG_MODE: 'true', OPENROUTER_API_KEY: 'test' };

        const result = await callOpenRouter(env, []);
        expect(result.choices[0].message.content).toBe('This is a debug mode response.');
        expect(result.choices[0].finish_reason).toBe('stop');
    });

    it('calls OpenRouter API when not in debug mode', async () => {
        const mockResponse = {
            choices: [{ message: { role: 'assistant', content: 'Test response' }, finish_reason: 'stop' }]
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockResponse
        });

        const env = { DEBUG_MODE: 'false', OPENROUTER_API_KEY: 'sk-test-key' };
        const messages = [{ role: 'user', content: 'Hello' }];

        const result = await callOpenRouter(env, messages);
        expect(result.choices[0].message.content).toBe('Test response');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        const [url, opts] = globalThis.fetch.mock.calls[0];
        expect(url).toContain('openrouter.ai');
        expect(opts.headers.Authorization).toBe('Bearer sk-test-key');
    });

    it('throws on API error', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            text: async () => 'Rate limited'
        });

        const env = { DEBUG_MODE: 'false', OPENROUTER_API_KEY: 'sk-test-key' };
        await expect(callOpenRouter(env, [])).rejects.toThrow('OpenRouter Error');
    });
});
