/**
 * Presentation helpers shared by every screen.
 *
 * The parish operates in Lagos, so all date rendering is pinned to
 * `Africa/Lagos` regardless of the visitor's device timezone — otherwise a
 * digest "scheduled for 07:30" would read as a different time for staff
 * travelling abroad and would disagree with the server's own output.
 */

export const TIMEZONE = 'Africa/Lagos';

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const shortDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | Date | null | undefined): string {
  const date = value ? toDate(value) : null;
  return date ? dateFormatter.format(date) : '—';
}

export function formatShortDate(value: string | Date | null | undefined): string {
  const date = value ? toDate(value) : null;
  return date ? shortDateFormatter.format(date) : '—';
}

export function formatTime(value: string | Date | null | undefined): string {
  const date = value ? toDate(value) : null;
  return date ? timeFormatter.format(date) : '—';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const date = value ? toDate(value) : null;
  return date ? dateTimeFormatter.format(date) : '—';
}

/** "14 March" or "14 March 1985" when the year of birth is known. */
export function formatBirthday(month: number, day: number, year?: number | null): string {
  const name = MONTH_NAMES[month - 1];
  if (!name) return '—';
  return year ? `${day} ${name} ${year}` : `${day} ${name}`;
}

/** Today's date in Lagos as `YYYY-MM-DD`, safe for `<input type="date">`. */
export function lagosToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

/** Compact "3 minutes ago" style stamp for audit trails and activity lists. */
export function formatRelative(value: string | Date | null | undefined, now = Date.now()): string {
  const date = value ? toDate(value) : null;
  if (!date) return '—';
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
  ];
  const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) < size * (unit === 'minute' ? 60 : unit === 'hour' ? 24 : unit === 'day' ? 7 : 5)) {
      return relative.format(-Math.round(seconds / size), unit);
    }
  }
  return shortDateFormatter.format(date);
}

export function formatCount(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return new Intl.NumberFormat('en-GB').format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'No data yet';
  return `${Math.round(value)}%`;
}

/** Turn "2348031234567" into "+234 803 123 4567" for human reading. */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '—';
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return value;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}

export function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

/** Days between today (Lagos) and a date, ignoring the time component. */
export function daysUntil(value: string | Date, today = lagosToday()): number {
  const target = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  const a = new Date(`${today}T00:00:00Z`).getTime();
  const b = new Date(`${target}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function describeDaysUntil(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? 'In 1 week' : `In ${weeks} weeks`;
}
