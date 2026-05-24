export function formatDateInZone(date, timezone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
    }).format(date);
}

export function formatTimeInZone(isoTimestamp, timezone) {
    const d = new Date(isoTimestamp.includes('T') && !isoTimestamp.endsWith('Z') ? isoTimestamp : isoTimestamp);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit'
    }).format(d);
}

export function formatEntry(e, timezone, proteinFocused = false) {
    const time = formatTimeInZone(e.timestamp, timezone);
    const parts = [`${time} — ${e.meal_title || 'Meal'}`];
    const macros = [];
    if (proteinFocused) {
        if (e.total_protein) macros.push(`${Math.round(e.total_protein)}g P`);
        else macros.push('0g P');
    } else {
        macros.push(`${Math.round(e.total_calories || 0)} cal`);
        if (e.total_protein) macros.push(`${Math.round(e.total_protein)}g P`);
        if (e.total_carbs) macros.push(`${Math.round(e.total_carbs)}g C`);
    }
    parts.push(`(${macros.join(', ')})`);
    if (Array.isArray(e.items) && e.items.length > 0) {
        const itemList = e.items.map(i => i.name).filter(Boolean).join(', ');
        if (itemList) parts.push(`— items: ${itemList}`);
    }
    return `- ${parts.join(' ')}`;
}

export function todayBoundsLocal(clientNow) {
    const datePart = clientNow.split('T')[0];
    return {
        startISO: `${datePart}T00:00:00`,
        endISO: `${datePart}T23:59:59`
    };
}

export function fmtDate(date) {
    const yr = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const dy = String(date.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${dy}`;
}

export function yesterdayBoundsLocal(clientNow) {
    const datePart = clientNow.split('T')[0];
    const [y, m, d] = datePart.split('-').map(Number);
    const yesterday = new Date(y, m - 1, d);
    yesterday.setDate(yesterday.getDate() - 1);
    const ymd = fmtDate(yesterday);
    return {
        startISO: `${ymd}T00:00:00`,
        endISO: `${ymd}T23:59:59`
    };
}

export function priorWeekBoundsLocal(clientNow) {
    const datePart = clientNow.split('T')[0];
    const [y, m, d] = datePart.split('-').map(Number);
    const today = new Date(y, m - 1, d);
    const twoAgo = new Date(today);
    twoAgo.setDate(twoAgo.getDate() - 2);
    const eightAgo = new Date(today);
    eightAgo.setDate(eightAgo.getDate() - 8);
    return {
        startISO: `${fmtDate(eightAgo)}T00:00:00`,
        endISO: `${fmtDate(twoAgo)}T23:59:59`
    };
}

export const MEAL_SPLIT = {
    BREAKFAST: { cal: 0.25, protein: 0.30, label: 'Breakfast', range: '4–11 AM' },
    LUNCH:     { cal: 0.30, protein: 0.30, label: 'Lunch',     range: '11 AM–4 PM' },
    DINNER:    { cal: 0.30, protein: 0.30, label: 'Dinner',    range: '4–10 PM' },
    SNACK:     { cal: 0.15, protein: 0.10, label: 'Snack',     range: 'other times' }
};

export function bucketByHour(h) {
    if (h >= 4 && h < 11) return 'BREAKFAST';
    if (h >= 11 && h < 16) return 'LUNCH';
    if (h >= 16 && h < 22) return 'DINNER';
    return 'SNACK';
}

export function bucketEntries(entries) {
    const buckets = { BREAKFAST: [], LUNCH: [], DINNER: [], SNACK: [] };
    for (const e of entries) {
        const timePart = e.timestamp.split('T')[1] || '00:00:00';
        const hour = parseInt(timePart.split(':')[0], 10);
        buckets[bucketByHour(hour)].push(e);
    }
    return buckets;
}

export function buildBudgetBlock(settings, buckets, todayTotal, todayProtein, clientNow) {
    const proteinFocused = settings.protein_focused_mode === 1;
    const dailyCal = settings.maintenance_calories;
    const dailyProt = settings.protein_goal;
    if (!dailyCal && !dailyProt) return null;

    const protBudget = dailyProt || 150;
    const remProt = Math.max(0, protBudget - todayProtein);

    const hourNow = parseInt((clientNow.split('T')[1] || '00:00').split(':')[0], 10);
    const currentBucket = bucketByHour(hourNow);

    const lines = [];

    if (proteinFocused) {
        lines.push(`Daily protein target: ${protBudget}g.`);
        lines.push(`Consumed today: ${Math.round(todayProtein)}g.`);
        lines.push(`Remaining today: ${Math.round(remProt)}g.`);
        lines.push('');
        lines.push('Protein distribution by meal slot:');
        for (const key of ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']) {
            const split = MEAL_SPLIT[key];
            const tgtProt = Math.round(protBudget * split.protein);
            const consumedProt = buckets[key].reduce((s, e) => s + (e.total_protein || 0), 0);
            const status = buckets[key].length === 0
                ? 'not logged'
                : `${Math.round(consumedProt)}/${tgtProt}g`;
            const flag = key === currentBucket ? '  ← current meal slot' : '';
            lines.push(`- ${split.label} (${split.range}): target ${tgtProt}g — ${status}${flag}`);
        }
        return lines.join('\n');
    }

    const calBudget = dailyCal || 2000;
    const remCal = Math.max(0, calBudget - todayTotal);
    lines.push(`Daily targets: ${calBudget} cal · ${protBudget}g protein.`);
    lines.push(`Consumed today: ${Math.round(todayTotal)} cal · ${Math.round(todayProtein)}g protein.`);
    lines.push(`Remaining today: ${Math.round(remCal)} cal · ${Math.round(remProt)}g protein.`);
    lines.push('');
    lines.push('Meal plan (suggested distribution):');
    for (const key of ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']) {
        const split = MEAL_SPLIT[key];
        const tgtCal = Math.round(calBudget * split.cal);
        const tgtProt = Math.round(protBudget * split.protein);
        const consumedCal = buckets[key].reduce((s, e) => s + (e.total_calories || 0), 0);
        const consumedProt = buckets[key].reduce((s, e) => s + (e.total_protein || 0), 0);
        const status = buckets[key].length === 0
            ? 'not logged'
            : `${Math.round(consumedCal)}/${tgtCal} cal, ${Math.round(consumedProt)}/${tgtProt}g P`;
        const flag = key === currentBucket ? '  ← current meal slot' : '';
        lines.push(`- ${split.label} (${split.range}): target ${tgtCal} cal / ${tgtProt}g P — ${status}${flag}`);
    }
    return lines.join('\n');
}

export const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_meals_last_7_days',
            description: "Fetch the user's meals from days -2 through -8 (the week BEFORE yesterday). Today and yesterday are already in the system prompt; do not call this for those. Use only for weekly trend analysis or older comparisons.",
            parameters: { type: 'object', properties: {}, required: [] }
        }
    }
];

export async function executeTool(name, storage, userId, clientNow, timezone) {
    if (name === 'get_meals_last_7_days') {
        const { startISO, endISO } = priorWeekBoundsLocal(clientNow);
        const entries = await storage.getEntriesBetween(userId, startISO, endISO);
        const formatted = entries.map(e => {
            const dateStr = e.timestamp.split('T')[0];
            return {
                date: dateStr,
                time: formatTimeInZone(e.timestamp, timezone),
                meal_title: e.meal_title,
                calories: Math.round(e.total_calories || 0),
                protein_g: Math.round(e.total_protein || 0),
                carbs_g: Math.round(e.total_carbs || 0),
                items: (e.items || []).map(i => i.name).filter(Boolean)
            };
        });
        return { entries: formatted, count: formatted.length };
    }
    return { error: `Unknown tool: ${name}` };
}

export async function* streamOpenRouterChunks(env, messages, tools) {
    const body = {
        model: 'openai/gpt-5.5',
        messages,
        stream: true,
        reasoning: { effort: 'medium' },
        tools,
        tool_choice: 'auto'
    };

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://cuuush.com',
            'X-Title': 'Calorie Tracker — Chat'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') return;
            try {
                yield JSON.parse(data);
            } catch {
                // ignore non-JSON
            }
        }
    }
}
