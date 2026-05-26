import { fetchWithRetry } from '$lib/net.js';

function parseItems(items) {
	if (!items) return [];
	return typeof items === 'string' ? JSON.parse(items) : items;
}

function scaleItems(items, fraction) {
	return items.map((item) => ({
		...item,
		calories: Math.round(item.calories * fraction),
		protein: Math.round(item.protein * fraction * 10) / 10,
		carbs: Math.round(item.carbs * fraction * 10) / 10
	}));
}

function fractionLabel(fraction) {
	if (fraction === 0.5) return '1/2';
	if (fraction < 0.34) return '1/3';
	return '2/3';
}

export async function copyEntry(entry, timestamp) {
	const items = parseItems(entry.items);
	const body = {
		timestamp,
		meal_title: entry.meal_title,
		items,
		total_calories: entry.total_calories,
		total_protein: entry.total_protein,
		total_carbs: entry.total_carbs,
		user_message: entry.user_message || null
	};

	const res = await fetchWithRetry('/api/entry', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	if (!res.ok) throw new Error('Failed to copy entry');
	return res.json();
}

export async function splitEntry(entry, fraction, timestamp) {
	const items = parseItems(entry.items);
	const remaining = 1 - fraction;
	const label = fractionLabel(fraction);

	const movedItems = scaleItems(items, fraction);
	const newBody = {
		timestamp,
		meal_title: `${entry.meal_title} (${label})`,
		items: movedItems,
		total_calories: Math.round(entry.total_calories * fraction),
		total_protein: Math.round(entry.total_protein * fraction * 10) / 10,
		total_carbs: Math.round(entry.total_carbs * fraction * 10) / 10,
		user_message: entry.user_message || null
	};

	const createRes = await fetchWithRetry('/api/entry', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(newBody)
	});
	if (!createRes.ok) throw new Error('Failed to create split entry');

	const remainingLabel = fractionLabel(remaining);
	const remainingItems = scaleItems(items, remaining);
	const patchBody = {
		meal_title: `${entry.meal_title} (${remainingLabel})`,
		items: remainingItems
	};

	const patchRes = await fetchWithRetry(`/api/entry/${entry.id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(patchBody)
	});
	if (!patchRes.ok) throw new Error('Failed to update original entry');

	return { created: await createRes.json(), updated: await patchRes.json() };
}
