import { describe, expect, it } from 'vitest';
import {
  addDays,
  birthdayMatchesDate,
  isLeapYear,
  isValidMonthDay,
  lagosClock,
  lagosMinuteKey,
  parseIsoDate,
  toIsoDate,
} from '../calendar.js';

describe('isLeapYear', () => {
  it('follows the Gregorian rule', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2026)).toBe(false);
  });
});

describe('isValidMonthDay', () => {
  it('accepts real calendar dates', () => {
    expect(isValidMonthDay(2, 29)).toBe(true);
    expect(isValidMonthDay(12, 31)).toBe(true);
    expect(isValidMonthDay(4, 30)).toBe(true);
  });

  it('rejects impossible or non-numeric values', () => {
    expect(isValidMonthDay(2, 30)).toBe(false);
    expect(isValidMonthDay(4, 31)).toBe(false);
    expect(isValidMonthDay(0, 1)).toBe(false);
    expect(isValidMonthDay(13, 1)).toBe(false);
    expect(isValidMonthDay(1, 0)).toBe(false);
    expect(isValidMonthDay(null, 1)).toBe(false);
    expect(isValidMonthDay(1.5, 1)).toBe(false);
    expect(isValidMonthDay('1', 1)).toBe(false);
  });
});

describe('parseIsoDate', () => {
  it('parses valid ISO dates', () => {
    expect(parseIsoDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it('rejects malformed or impossible dates', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('28/02/2026')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
  });
});

describe('toIsoDate / addDays', () => {
  it('pads single digit months and days', () => {
    expect(toIsoDate({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05');
  });

  it('rolls over month and year boundaries', () => {
    expect(addDays({ year: 2026, month: 2, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 1 });
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it('round-trips through ISO strings', () => {
    expect(parseIsoDate(toIsoDate(addDays({ year: 2026, month: 1, day: 31 }, 30)))).toEqual({
      year: 2026,
      month: 3,
      day: 2,
    });
  });
});

describe('birthdayMatchesDate', () => {
  const member = (month: number, day: number) => ({ birth_month: month, birth_day: day });

  it('matches the exact month and day', () => {
    expect(birthdayMatchesDate(member(9, 14), { year: 2026, month: 9, day: 14 })).toBe(true);
    expect(birthdayMatchesDate(member(9, 14), { year: 2026, month: 9, day: 15 })).toBe(false);
  });

  it('accepts string columns from the database', () => {
    expect(birthdayMatchesDate({ birth_month: '9', birth_day: '14' }, { year: 2026, month: 9, day: 14 })).toBe(true);
  });

  it('matches 29 February on 29 February in a leap year', () => {
    expect(birthdayMatchesDate(member(2, 29), { year: 2028, month: 2, day: 29 })).toBe(true);
    expect(birthdayMatchesDate(member(2, 29), { year: 2028, month: 2, day: 28 })).toBe(false);
  });

  it('falls back to 28 February in a non-leap year by default', () => {
    expect(birthdayMatchesDate(member(2, 29), { year: 2026, month: 2, day: 28 })).toBe(true);
    expect(birthdayMatchesDate(member(2, 29), { year: 2026, month: 3, day: 1 })).toBe(false);
  });

  it('honours the mar1 parish policy in a non-leap year', () => {
    expect(birthdayMatchesDate(member(2, 29), { year: 2026, month: 3, day: 1 }, 'mar1')).toBe(true);
    expect(birthdayMatchesDate(member(2, 29), { year: 2026, month: 2, day: 28 }, 'mar1')).toBe(false);
  });
});

describe('lagos clock helpers', () => {
  it('formats a known instant in Africa/Lagos (UTC+1, no DST)', () => {
    const instant = new Date('2026-09-03T06:30:00.000Z');
    expect(lagosClock(instant)).toBe('07:30');
    expect(lagosMinuteKey(instant)).toBe('2026-09-03:07:30');
  });

  it('crosses midnight with the parish, not with UTC', () => {
    const instant = new Date('2026-09-03T23:30:00.000Z');
    expect(lagosMinuteKey(instant)).toBe('2026-09-04:00:30');
  });
});
