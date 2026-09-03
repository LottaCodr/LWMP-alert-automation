import type { DateParts, Feb29Policy } from '../types.js';

/**
 * Calendar rules for the birthday-care schedule.
 *
 * Every rule is evaluated in **Africa/Lagos**, because a "birthday" in this
 * product means the parish's local calendar day. None of these functions touch
 * the database, so they are unit-tested directly in `server/domain/__tests__`.
 */

export const PARISH_TIMEZONE = 'Africa/Lagos';

const DAYS_IN_MONTH: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidMonthDay(month: unknown, day: unknown): boolean {
  if (typeof month !== 'number' || typeof day !== 'number') return false;
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= (DAYS_IN_MONTH[month - 1] ?? 0);
}

export function lagosDateParts(date: Date = new Date()): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARISH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Current `HH:mm` in the parish timezone, using a 24-hour clock. */
export function lagosClock(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARISH_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

export function toIsoDate({ year, month, day }: DateParts): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseIsoDate(input: unknown): DateParts | null {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const [rawYear, rawMonth, rawDay] = input.split('-');
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function addDays(parts: DateParts, amount: number): DateParts {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

export function daysFromLagosToday(amount: number, today: Date = new Date()): DateParts {
  return addDays(lagosDateParts(today), amount);
}

/**
 * Does this member's birthday occur on `date`?
 *
 * 29 February in a non-leap year follows one consistent parish policy: either
 * 28 February or 1 March. The policy is stored on the notification rule so the
 * behaviour is auditable rather than hidden in code.
 */
export function birthdayMatchesDate(
  member: { birth_month: number | string; birth_day: number | string },
  date: DateParts,
  feb29Policy: Feb29Policy = 'feb28',
): boolean {
  const month = Number(member.birth_month);
  const day = Number(member.birth_day);
  if (month === date.month && day === date.day) return true;
  if (month !== 2 || day !== 29) return false;
  if (isLeapYear(date.year)) return date.month === 2 && date.day === 29;
  if (feb29Policy === 'mar1') return date.month === 3 && date.day === 1;
  return date.month === 2 && date.day === 28;
}

/** Long human-readable date, e.g. `Monday, 14 September 2026`. */
export function formatLongDate(parts: DateParts, locale = 'en-NG'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: PARISH_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
}

/** A stable `YYYY-MM-DD:HH:mm` key used to guarantee one run per Lagos minute. */
export function lagosMinuteKey(now: Date = new Date()): string {
  return `${toIsoDate(lagosDateParts(now))}:${lagosClock(now)}`;
}
