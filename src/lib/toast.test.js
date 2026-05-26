// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast, dismiss, toasts } from './toast.svelte.js';

describe('toast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Clear any existing toasts from previous tests
        const current = toasts();
        current.splice(0, current.length);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('adds a toast to the list', () => {
        toast('Hello world');
        const list = toasts();
        expect(list).toHaveLength(1);
        expect(list[0].message).toBe('Hello world');
        expect(list[0].kind).toBe('info');
        expect(list[0].id).toBeDefined();
    });

    it('adds an error toast', () => {
        toast('Something went wrong', { kind: 'error' });
        const list = toasts();
        expect(list).toHaveLength(1);
        expect(list[0].message).toBe('Something went wrong');
        expect(list[0].kind).toBe('error');
    });

    it('adds a success toast', () => {
        toast('Saved!', { kind: 'success' });
        const list = toasts();
        expect(list).toHaveLength(1);
        expect(list[0].message).toBe('Saved!');
        expect(list[0].kind).toBe('success');
    });

    it('multiple toasts accumulate', () => {
        toast('First');
        toast('Second');
        toast('Third');
        const list = toasts();
        expect(list).toHaveLength(3);
        expect(list[0].message).toBe('First');
        expect(list[1].message).toBe('Second');
        expect(list[2].message).toBe('Third');
    });

    it('auto-dismisses after default timeout (4000ms)', () => {
        toast('Auto dismiss');
        expect(toasts()).toHaveLength(1);

        vi.advanceTimersByTime(3999);
        expect(toasts()).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(toasts()).toHaveLength(0);
    });

    it('auto-dismisses after custom duration', () => {
        toast('Quick toast', { duration: 1000 });
        expect(toasts()).toHaveLength(1);

        vi.advanceTimersByTime(999);
        expect(toasts()).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(toasts()).toHaveLength(0);
    });

    it('dismiss removes a specific toast by id', () => {
        toast('First');
        toast('Second');
        toast('Third');

        const list = toasts();
        expect(list).toHaveLength(3);

        const secondId = list[1].id;
        dismiss(secondId);

        expect(toasts()).toHaveLength(2);
        expect(toasts()[0].message).toBe('First');
        expect(toasts()[1].message).toBe('Third');
    });

    it('dismiss does nothing for unknown id', () => {
        toast('Hello');
        expect(toasts()).toHaveLength(1);

        dismiss(999999);
        expect(toasts()).toHaveLength(1);
    });

    it('toasts returns the current list', () => {
        const list = toasts();
        expect(Array.isArray(list)).toBe(true);
        expect(list).toHaveLength(0);

        toast('Test');
        // toasts() should reflect the new toast
        expect(toasts()).toHaveLength(1);
    });

    it('each toast gets a unique id', () => {
        toast('A');
        toast('B');
        const list = toasts();
        expect(list[0].id).not.toBe(list[1].id);
    });

    it('auto-dismiss only removes its own toast', () => {
        toast('Short', { duration: 1000 });
        toast('Long', { duration: 5000 });

        expect(toasts()).toHaveLength(2);

        vi.advanceTimersByTime(1000);
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0].message).toBe('Long');

        vi.advanceTimersByTime(4000);
        expect(toasts()).toHaveLength(0);
    });

    it('defaults kind to info when not specified', () => {
        toast('Default kind');
        expect(toasts()[0].kind).toBe('info');
    });
});
