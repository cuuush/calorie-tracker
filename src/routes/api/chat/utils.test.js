import { describe, it, expect } from 'vitest';
import {
    todayBoundsLocal,
    yesterdayBoundsLocal,
    priorWeekBoundsLocal,
    fmtDate,
    bucketByHour,
    bucketEntries,
    formatEntry,
    buildBudgetBlock,
    MEAL_SPLIT
} from './utils.js';

describe('todayBoundsLocal', () => {
    it('returns correct start/end for a given time', () => {
        const result = todayBoundsLocal('2026-05-24T14:30:00');
        expect(result.startISO).toBe('2026-05-24T00:00:00');
        expect(result.endISO).toBe('2026-05-24T23:59:59');
    });

    it('handles midnight', () => {
        const result = todayBoundsLocal('2026-01-01T00:00:00');
        expect(result.startISO).toBe('2026-01-01T00:00:00');
        expect(result.endISO).toBe('2026-01-01T23:59:59');
    });
});

describe('yesterdayBoundsLocal', () => {
    it('returns yesterday boundaries', () => {
        const result = yesterdayBoundsLocal('2026-05-24T14:30:00');
        expect(result.startISO).toBe('2026-05-23T00:00:00');
        expect(result.endISO).toBe('2026-05-23T23:59:59');
    });

    it('handles month boundary', () => {
        const result = yesterdayBoundsLocal('2026-03-01T10:00:00');
        expect(result.startISO).toBe('2026-02-28T00:00:00');
        expect(result.endISO).toBe('2026-02-28T23:59:59');
    });

    it('handles year boundary', () => {
        const result = yesterdayBoundsLocal('2026-01-01T10:00:00');
        expect(result.startISO).toBe('2025-12-31T00:00:00');
        expect(result.endISO).toBe('2025-12-31T23:59:59');
    });
});

describe('priorWeekBoundsLocal', () => {
    it('returns days -2 through -8', () => {
        const result = priorWeekBoundsLocal('2026-05-24T14:30:00');
        expect(result.startISO).toBe('2026-05-16T00:00:00');
        expect(result.endISO).toBe('2026-05-22T23:59:59');
    });
});

describe('fmtDate', () => {
    it('formats a date as YYYY-MM-DD', () => {
        expect(fmtDate(new Date(2026, 4, 24))).toBe('2026-05-24');
    });

    it('pads single-digit month and day', () => {
        expect(fmtDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    });
});

describe('bucketByHour', () => {
    it('classifies late night as SNACK', () => {
        expect(bucketByHour(3)).toBe('SNACK');
    });

    it('classifies 4 AM as BREAKFAST', () => {
        expect(bucketByHour(4)).toBe('BREAKFAST');
    });

    it('classifies 10 AM as BREAKFAST', () => {
        expect(bucketByHour(10)).toBe('BREAKFAST');
    });

    it('classifies 11 AM as LUNCH', () => {
        expect(bucketByHour(11)).toBe('LUNCH');
    });

    it('classifies 15 (3 PM) as LUNCH', () => {
        expect(bucketByHour(15)).toBe('LUNCH');
    });

    it('classifies 16 (4 PM) as DINNER', () => {
        expect(bucketByHour(16)).toBe('DINNER');
    });

    it('classifies 21 (9 PM) as DINNER', () => {
        expect(bucketByHour(21)).toBe('DINNER');
    });

    it('classifies 22 (10 PM) as SNACK', () => {
        expect(bucketByHour(22)).toBe('SNACK');
    });
});

describe('bucketEntries', () => {
    it('buckets entries by timestamp hour', () => {
        const entries = [
            { timestamp: '2026-05-24T08:00:00', meal_title: 'Oatmeal' },
            { timestamp: '2026-05-24T12:30:00', meal_title: 'Sandwich' },
            { timestamp: '2026-05-24T19:00:00', meal_title: 'Steak' },
            { timestamp: '2026-05-24T23:00:00', meal_title: 'Snack' }
        ];
        const buckets = bucketEntries(entries);
        expect(buckets.BREAKFAST).toHaveLength(1);
        expect(buckets.LUNCH).toHaveLength(1);
        expect(buckets.DINNER).toHaveLength(1);
        expect(buckets.SNACK).toHaveLength(1);
        expect(buckets.BREAKFAST[0].meal_title).toBe('Oatmeal');
    });

    it('handles empty entries', () => {
        const buckets = bucketEntries([]);
        expect(buckets.BREAKFAST).toHaveLength(0);
        expect(buckets.LUNCH).toHaveLength(0);
        expect(buckets.DINNER).toHaveLength(0);
        expect(buckets.SNACK).toHaveLength(0);
    });
});

describe('formatEntry', () => {
    const entry = {
        timestamp: '2026-05-24T12:30:00',
        meal_title: 'Chicken Bowl',
        total_calories: 500,
        total_protein: 40,
        total_carbs: 50,
        items: [{ name: 'Chicken' }, { name: 'Rice' }]
    };

    it('formats with calories by default', () => {
        const result = formatEntry(entry, 'America/New_York');
        expect(result).toContain('Chicken Bowl');
        expect(result).toContain('500 cal');
        expect(result).toContain('40g P');
        expect(result).toContain('50g C');
        expect(result).toContain('Chicken, Rice');
    });

    it('formats protein-focused mode', () => {
        const result = formatEntry(entry, 'America/New_York', true);
        expect(result).toContain('40g P');
        expect(result).not.toContain('cal');
        expect(result).not.toContain('g C');
    });

    it('shows 0g P when protein is missing in protein-focused mode', () => {
        const noProtein = { ...entry, total_protein: 0 };
        const result = formatEntry(noProtein, 'America/New_York', true);
        expect(result).toContain('0g P');
    });
});

describe('buildBudgetBlock', () => {
    const settings = {
        maintenance_calories: 2200,
        protein_goal: 150,
        protein_focused_mode: 0
    };
    const emptyBuckets = { BREAKFAST: [], LUNCH: [], DINNER: [], SNACK: [] };

    it('returns null when no targets set', () => {
        const result = buildBudgetBlock({}, emptyBuckets, 0, 0, '2026-05-24T12:00:00');
        expect(result).toBeNull();
    });

    it('generates calorie + protein budget', () => {
        const result = buildBudgetBlock(settings, emptyBuckets, 800, 60, '2026-05-24T12:00:00');
        expect(result).toContain('2200 cal');
        expect(result).toContain('150g protein');
        expect(result).toContain('Remaining today');
        expect(result).toContain('← current meal slot');
    });

    it('generates protein-only budget in protein-focused mode', () => {
        const pfSettings = { ...settings, protein_focused_mode: 1 };
        const result = buildBudgetBlock(pfSettings, emptyBuckets, 800, 60, '2026-05-24T12:00:00');
        expect(result).toContain('Daily protein target');
        expect(result).not.toContain('cal');
    });
});
