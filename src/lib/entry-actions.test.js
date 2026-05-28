import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/toast.svelte.js', () => ({
	toast: vi.fn()
}));

vi.mock('$lib/net.js', () => ({
	fetchWithRetry: vi.fn()
}));

import { copyEntry, splitEntry } from './entry-actions.js';
import { fetchWithRetry } from '$lib/net.js';

const ENTRY = {
	id: 'original-123',
	meal_title: 'Chicken & Rice',
	total_calories: 600,
	total_protein: 50,
	total_carbs: 40,
	user_message: 'chicken and rice',
	items: [
		{ name: 'Grilled Chicken', calories: 400, protein: 45, carbs: 0 },
		{ name: 'Brown Rice', calories: 200, protein: 5, carbs: 40 }
	]
};

function mockOk(data) {
	fetchWithRetry.mockResolvedValueOnce({
		ok: true,
		json: () => Promise.resolve(data)
	});
}

function callBody(idx) {
	const call = fetchWithRetry.mock.calls[idx];
	return JSON.parse(call[1].body);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('copyEntry', () => {
	it('posts to /api/entry with same macros, items, and target timestamp', async () => {
		mockOk({ id: 'new-1', meal_title: 'Chicken & Rice' });

		await copyEntry(ENTRY, '2026-05-26T08:00:00');

		expect(fetchWithRetry).toHaveBeenCalledOnce();
		const [url, opts] = fetchWithRetry.mock.calls[0];
		expect(url).toBe('/api/entry');
		expect(opts.method).toBe('POST');

		const body = callBody(0);
		expect(body.meal_title).toBe('Chicken & Rice');
		expect(body.timestamp).toBe('2026-05-26T08:00:00');
		expect(body.total_calories).toBe(600);
		expect(body.total_protein).toBe(50);
		expect(body.total_carbs).toBe(40);
		expect(body.items).toEqual(ENTRY.items);
	});

	it('does not include the original id', async () => {
		mockOk({ id: 'new-2' });
		await copyEntry(ENTRY, '2026-05-26T12:00:00');
		const body = callBody(0);
		expect(body.id).toBeUndefined();
	});

	it('handles items stored as a JSON string', async () => {
		mockOk({ id: 'new-3' });
		const entry = { ...ENTRY, items: JSON.stringify(ENTRY.items) };
		await copyEntry(entry, '2026-05-26T12:00:00');
		const body = callBody(0);
		expect(body.items).toEqual(ENTRY.items);
	});

	it('throws on non-ok response', async () => {
		fetchWithRetry.mockResolvedValueOnce({ ok: false, status: 500 });
		await expect(copyEntry(ENTRY, '2026-05-26T12:00:00')).rejects.toThrow('Failed to copy entry');
	});
});

describe('splitEntry', () => {
	it('creates new entry with moved fraction and patches original with remainder', async () => {
		mockOk({ id: 'split-new' });
		mockOk({ success: true });

		await splitEntry(ENTRY, 1 / 3, '2026-05-27T08:00:00');

		expect(fetchWithRetry).toHaveBeenCalledTimes(2);

		const [createUrl, createOpts] = fetchWithRetry.mock.calls[0];
		expect(createUrl).toBe('/api/entry');
		expect(createOpts.method).toBe('POST');
		const createBody = callBody(0);
		expect(createBody.meal_title).toBe('Chicken & Rice (1/3)');
		expect(createBody.timestamp).toBe('2026-05-27T08:00:00');
		expect(createBody.total_calories).toBe(200);
		expect(createBody.total_protein).toBeCloseTo(16.7, 1);

		const [patchUrl, patchOpts] = fetchWithRetry.mock.calls[1];
		expect(patchUrl).toBe('/api/entry/original-123');
		expect(patchOpts.method).toBe('PATCH');
		const patchBody = callBody(1);
		expect(patchBody.meal_title).toBe('Chicken & Rice (2/3)');
		expect(patchBody.items[0].calories).toBe(267);
		expect(patchBody.items[1].calories).toBe(133);
	});

	it('creates a 1/2 split correctly', async () => {
		mockOk({ id: 'split-half' });
		mockOk({ success: true });

		await splitEntry(ENTRY, 0.5, '2026-05-26T19:00:00');

		const createBody = callBody(0);
		expect(createBody.meal_title).toBe('Chicken & Rice (1/2)');
		expect(createBody.total_calories).toBe(300);
		expect(createBody.items[0].calories).toBe(200);
		expect(createBody.items[1].calories).toBe(100);

		const patchBody = callBody(1);
		expect(patchBody.meal_title).toBe('Chicken & Rice (1/2)');
		expect(patchBody.items[0].calories).toBe(200);
		expect(patchBody.items[1].calories).toBe(100);
	});

	it('creates a 2/3 split correctly', async () => {
		mockOk({ id: 'split-twothird' });
		mockOk({ success: true });

		await splitEntry(ENTRY, 2 / 3, '2026-05-26T13:00:00');

		const createBody = callBody(0);
		expect(createBody.meal_title).toBe('Chicken & Rice (2/3)');
		expect(createBody.total_calories).toBe(400);

		const patchBody = callBody(1);
		expect(patchBody.meal_title).toBe('Chicken & Rice (1/3)');
	});

	it('scales individual item macros for the moved portion', async () => {
		mockOk({ id: 'split-items' });
		mockOk({ success: true });

		await splitEntry(ENTRY, 0.5, '2026-05-26T12:00:00');

		const createBody = callBody(0);
		const chicken = createBody.items[0];
		expect(chicken.name).toBe('Grilled Chicken');
		expect(chicken.calories).toBe(200);
		expect(chicken.protein).toBe(22.5);
		expect(chicken.carbs).toBe(0);

		const rice = createBody.items[1];
		expect(rice.calories).toBe(100);
		expect(rice.protein).toBe(2.5);
		expect(rice.carbs).toBe(20);
	});

	it('throws if creating the new entry fails', async () => {
		fetchWithRetry.mockResolvedValueOnce({ ok: false, status: 500 });
		await expect(splitEntry(ENTRY, 0.5, '2026-05-26T12:00:00')).rejects.toThrow('Failed to create split entry');
		expect(fetchWithRetry).toHaveBeenCalledOnce();
	});

	it('throws if patching the original fails', async () => {
		mockOk({ id: 'split-ok' });
		fetchWithRetry.mockResolvedValueOnce({ ok: false, status: 500 });
		await expect(splitEntry(ENTRY, 0.5, '2026-05-26T12:00:00')).rejects.toThrow('Failed to update original entry');
	});

	it('handles items stored as a JSON string', async () => {
		mockOk({ id: 'split-str' });
		mockOk({ success: true });
		const entry = { ...ENTRY, items: JSON.stringify(ENTRY.items) };
		await splitEntry(entry, 0.5, '2026-05-26T12:00:00');
		const createBody = callBody(0);
		expect(createBody.items).toHaveLength(2);
		expect(createBody.items[0].calories).toBe(200);
	});
});
