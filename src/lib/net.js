// Fetch wrapper with exponential backoff for flaky networks (subway, etc).
// Retries on network errors and 5xx responses. Does NOT retry 4xx — those are
// client errors that won't get better on retry.

import { toast } from '$lib/toast.svelte.js';

const TOTAL_BUDGET_MS = 5 * 60 * 1000; // keep trying for 5 minutes
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4000;

function isRetriableStatus(status) {
    return status === 0 || status >= 500;
}

function delayFor(attempt) {
    const exp = BASE_DELAY_MS * Math.pow(2, attempt);
    return Math.min(exp, MAX_DELAY_MS);
}

// Sleep that resolves early if the AbortSignal fires. Returns true if aborted.
export function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve(true);
        const t = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve(false);
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            resolve(true);
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

// Wait for navigator.onLine to flip to true (or for an abort). Returns true if aborted.
// Falls through immediately if already online or in a non-browser environment.
function waitForOnline(signal) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const onOnline = () => { cleanup(); resolve(false); };
        const onAbort = () => { cleanup(); resolve(true); };
        function cleanup() {
            window.removeEventListener('online', onOnline);
            signal?.removeEventListener?.('abort', onAbort);
        }
        window.addEventListener('online', onOnline);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/**
 * fetch with retry + exponential backoff, capped by a total wall-clock budget.
 * Honors navigator.onLine — when offline, waits for the 'online' event instead
 * of busy-retrying fetches that will fail immediately.
 *
 * @param {string|URL|Request} url
 * @param {RequestInit & { budgetMs?: number, silent?: boolean }} [init]
 *   - budgetMs: total wall-clock time to keep retrying (default 5 min).
 *   - silent: suppress the "Reconnecting…" toast.
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init = {}) {
    const { budgetMs = TOTAL_BUDGET_MS, silent = false, ...rest } = init;
    const signal = rest.signal;
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    let lastErr;
    let toastShown = false;

    const showReconnectToast = () => {
        if (silent || toastShown) return;
        toast('Reconnecting…');
        toastShown = true;
    };

    while (true) {
        if (signal?.aborted) {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            throw e;
        }

        // If the browser thinks we're offline, don't even try — wait for online.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            showReconnectToast();
            const aborted = await waitForOnline(signal);
            if (aborted) {
                const e = new Error('Aborted');
                e.name = 'AbortError';
                throw e;
            }
            // Don't reset the attempt counter — keep escalating backoff if this
            // is a flaky connection that flips offline repeatedly.
        }

        let succeeded = false;
        try {
            const res = await fetch(url, rest);
            if (res.ok || !isRetriableStatus(res.status)) {
                succeeded = true;
                return res;
            }
            // Retriable 5xx — fall through to retry path.
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            // AbortError shouldn't be retried.
            if (err?.name === 'AbortError') throw err;
            lastErr = err;
        } finally {
            if (!succeeded && attempt > 0) showReconnectToast();
        }

        const wait = delayFor(attempt);
        if (Date.now() + wait > deadline) break;
        showReconnectToast();
        const aborted = await abortableSleep(wait, signal);
        if (aborted) {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            throw e;
        }
        attempt++;
    }
    throw lastErr || new Error('Request failed');
}

/**
 * Upload a single file (Blob/File) via XHR so we can report progress events.
 *
 * @param {string} url
 * @param {Blob|File} file
 * @param {{ field?: string, onProgress?: (frac: number) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<any>} parsed JSON response
 */
export function uploadFile(url, file, opts = {}) {
    const { field = 'file', onProgress, signal } = opts;
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);

        if (signal) {
            if (signal.aborted) {
                xhr.abort();
                const e = new Error('Aborted'); e.name = 'AbortError';
                return reject(e);
            }
            signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try { resolve(JSON.parse(xhr.responseText)); }
                catch { resolve(xhr.responseText); }
            } else {
                reject(new Error(`Upload failed: HTTP ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => {
            const e = new Error('Aborted'); e.name = 'AbortError';
            reject(e);
        };

        const form = new FormData();
        form.append(field, file);
        xhr.send(form);
    });
}
