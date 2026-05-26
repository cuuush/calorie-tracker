// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the toast module before importing net.js
vi.mock('$lib/toast.svelte.js', () => ({
    toast: vi.fn(),
    dismiss: vi.fn(),
    toasts: vi.fn(() => [])
}));

import { abortableSleep, fetchWithRetry, uploadFile } from './net.js';
import { toast } from '$lib/toast.svelte.js';

describe('abortableSleep', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves after given ms with false', async () => {
        const p = abortableSleep(1000, undefined);
        vi.advanceTimersByTime(1000);
        const result = await p;
        expect(result).toBe(false);
    });

    it('resolves immediately with true if signal already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await abortableSleep(5000, ac.signal);
        expect(result).toBe(true);
    });

    it('resolves early with true when signal aborts mid-sleep', async () => {
        const ac = new AbortController();
        const p = abortableSleep(5000, ac.signal);
        // Advance partially, then abort
        vi.advanceTimersByTime(1000);
        ac.abort();
        const result = await p;
        expect(result).toBe(true);
    });

    it('resolves with false when no signal is provided', async () => {
        const p = abortableSleep(200);
        vi.advanceTimersByTime(200);
        const result = await p;
        expect(result).toBe(false);
    });
});

describe('fetchWithRetry', () => {
    let originalFetch;

    beforeEach(() => {
        vi.useFakeTimers();
        originalFetch = globalThis.fetch;
        vi.mocked(toast).mockClear();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('successful fetch returns response immediately', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const res = await fetchWithRetry('/api/test');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries on 500 error, succeeds on second try', async () => {
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response('error', { status: 500 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = fetchWithRetry('/api/test', { budgetMs: 30000 });

        // First attempt fails with 500, then sleeps BASE_DELAY_MS (500ms)
        // We need to flush the microtask queue and advance timers
        await vi.advanceTimersByTimeAsync(600);

        const res = await promise;
        expect(res.status).toBe(200);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 4xx errors', async () => {
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response('not found', { status: 404 }));

        const res = await fetchWithRetry('/api/test', { budgetMs: 10000 });
        expect(res.status).toBe(404);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('returns 400 response without retry', async () => {
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response('bad request', { status: 400 }));

        const res = await fetchWithRetry('/api/test');
        expect(res.status).toBe(400);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws on AbortError without retrying', async () => {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        globalThis.fetch = vi.fn().mockRejectedValueOnce(abortErr);

        await expect(fetchWithRetry('/api/test')).rejects.toThrow('Aborted');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws when signal is already aborted', async () => {
        globalThis.fetch = vi.fn();
        const ac = new AbortController();
        ac.abort();

        await expect(
            fetchWithRetry('/api/test', { signal: ac.signal })
        ).rejects.toThrow('Aborted');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('throws after budget exhausted on repeated 500s', async () => {
        vi.useRealTimers();
        globalThis.fetch = vi.fn()
            .mockResolvedValue(new Response('error', { status: 500 }));

        await expect(fetchWithRetry('/api/test', { budgetMs: 200 }))
            .rejects.toThrow('HTTP 500');
        vi.useFakeTimers();
    });

    it('shows reconnecting toast on retry', async () => {
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response('error', { status: 500 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = fetchWithRetry('/api/test', { budgetMs: 30000 });
        await vi.advanceTimersByTimeAsync(600);
        await promise;

        expect(toast).toHaveBeenCalledWith('Reconnecting…');
    });

    it('does not show toast when silent is true', async () => {
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response('error', { status: 500 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = fetchWithRetry('/api/test', { budgetMs: 30000, silent: true });
        await vi.advanceTimersByTimeAsync(600);
        await promise;

        expect(toast).not.toHaveBeenCalled();
    });

    it('retries on network errors', async () => {
        globalThis.fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = fetchWithRetry('/api/test', { budgetMs: 30000 });
        await vi.advanceTimersByTimeAsync(600);

        const res = await promise;
        expect(res.status).toBe(200);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('respects abort signal during retry sleep', async () => {
        const ac = new AbortController();
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce(new Response('error', { status: 500 }));

        const promise = fetchWithRetry('/api/test', { signal: ac.signal, budgetMs: 30000 });

        // Let the first fetch resolve and enter the retry sleep
        await vi.advanceTimersByTimeAsync(100);

        // Abort during the sleep
        ac.abort();

        await expect(promise).rejects.toThrow('Aborted');
    });
});

describe('uploadFile', () => {
    // uploadFile uses XMLHttpRequest. jsdom provides a partial implementation
    // but it doesn't actually send requests. We mock XMLHttpRequest to test
    // the upload logic.

    let mockXhr;
    let OriginalXHR;

    beforeEach(() => {
        mockXhr = {
            open: vi.fn(),
            send: vi.fn(),
            abort: vi.fn(),
            status: 200,
            responseText: '{"ok":true}',
            upload: { onprogress: null },
            onload: null,
            onerror: null,
            onabort: null,
        };

        OriginalXHR = globalThis.XMLHttpRequest;
        globalThis.XMLHttpRequest = function () { return mockXhr; };
    });

    afterEach(() => {
        globalThis.XMLHttpRequest = OriginalXHR;
    });

    it('successful upload returns parsed JSON', async () => {
        mockXhr.send = vi.fn(() => {
            // Simulate successful load
            mockXhr.status = 200;
            mockXhr.responseText = '{"id":"abc","url":"/files/abc"}';
            mockXhr.onload();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        const result = await uploadFile('/api/upload', file);

        expect(result).toEqual({ id: 'abc', url: '/files/abc' });
        expect(mockXhr.open).toHaveBeenCalledWith('POST', '/api/upload');
    });

    it('triggers onProgress callback', async () => {
        const onProgress = vi.fn();

        mockXhr.send = vi.fn(() => {
            // Simulate progress event
            mockXhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
            mockXhr.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
            // Then complete
            mockXhr.status = 200;
            mockXhr.responseText = '{"ok":true}';
            mockXhr.onload();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        await uploadFile('/api/upload', file, { onProgress });

        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenCalledWith(0.5);
        expect(onProgress).toHaveBeenCalledWith(1);
    });

    it('rejects on HTTP error status', async () => {
        mockXhr.send = vi.fn(() => {
            mockXhr.status = 500;
            mockXhr.responseText = 'Internal Server Error';
            mockXhr.onload();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        await expect(uploadFile('/api/upload', file)).rejects.toThrow('Upload failed: HTTP 500');
    });

    it('rejects on network error', async () => {
        mockXhr.send = vi.fn(() => {
            mockXhr.onerror();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        await expect(uploadFile('/api/upload', file)).rejects.toThrow('Network error during upload');
    });

    it('rejects immediately if signal already aborted', async () => {
        const ac = new AbortController();
        ac.abort();

        const file = new Blob(['hello'], { type: 'text/plain' });
        await expect(
            uploadFile('/api/upload', file, { signal: ac.signal })
        ).rejects.toThrow('Aborted');
        expect(mockXhr.abort).toHaveBeenCalled();
    });

    it('rejects with AbortError on xhr abort', async () => {
        mockXhr.send = vi.fn(() => {
            mockXhr.onabort();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        const promise = uploadFile('/api/upload', file);
        await expect(promise).rejects.toThrow('Aborted');
    });

    it('uses custom field name', async () => {
        let sentForm;
        mockXhr.send = vi.fn((form) => {
            sentForm = form;
            mockXhr.status = 200;
            mockXhr.responseText = '{"ok":true}';
            mockXhr.onload();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        await uploadFile('/api/upload', file, { field: 'image' });

        // FormData was sent via xhr.send
        expect(sentForm).toBeInstanceOf(FormData);
        expect(sentForm.get('image')).toBeTruthy();
    });

    it('returns raw text when response is not valid JSON', async () => {
        mockXhr.send = vi.fn(() => {
            mockXhr.status = 200;
            mockXhr.responseText = 'not json';
            mockXhr.onload();
        });

        const file = new Blob(['hello'], { type: 'text/plain' });
        const result = await uploadFile('/api/upload', file);
        expect(result).toBe('not json');
    });
});
