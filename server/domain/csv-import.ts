import type { ImportRowDto } from '../types.js';
import { isValidMonthDay } from './calendar.js';
import { normalizeNigerianPhone } from './phone.js';

/**
 * CSV review logic for member imports.
 *
 * The CSV is never persisted: the browser sends text, this module validates and
 * annotates every row, an operator reviews the result, and only approved rows are
 * committed. All parsing is pure so the rules can be unit-tested.
 */

export const MAX_IMPORT_BYTES = 450_000;
export const MAX_IMPORT_ROWS = 500;
export const MIN_IMPORT_TEXT_LENGTH = 5;

export interface ParsedBirthday {
  year: number | null;
  month: number | null;
  day: number | null;
}

export type DuplicateLookup = (normalizedPhone: string) => { memberCode: string; fullName: string } | null;

type CsvRecord = Record<string, unknown>;

/**
 * Coerce a CSV cell to text. Objects and arrays are rejected rather than
 * stringified to "[object Object]", which would silently produce a bogus value.
 */
export function cellText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** Accepts `1992-09-14` and `14/09/1992` / `14-09-1992` (year optional). */
export function parseBirthdayString(value: unknown): ParsedBirthday | null {
  const raw = cellText(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const dayMonth = raw.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{4}))?$/);
  if (dayMonth) {
    return { day: Number(dayMonth[1]), month: Number(dayMonth[2]), year: dayMonth[3] ? Number(dayMonth[3]) : null };
  }
  return null;
}

/** Column lookup that tolerates `first_name`, `First Name`, `firstName`, … */
export function getField(row: CsvRecord, ...names: string[]): unknown {
  const normalise = (key: string): string => key.toLowerCase().replace(/[ _-]/g, '');
  for (const name of names) {
    const wanted = normalise(name);
    const hit = Object.keys(row).find((key) => normalise(key) === wanted);
    if (hit && row[hit] !== undefined) return row[hit];
  }
  return undefined;
}

/** CSV cells that spreadsheet apps would execute as formulas. */
export function isFormulaInjectionRisk(value: unknown): boolean {
  return /^[=+\-@\t\r]/.test(cellText(value));
}

function cleanString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function optionalNumber(value: unknown): number | null {
  const text = cellText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildImportRow(
  row: CsvRecord,
  rowNumber: number,
  lookupDuplicate: DuplicateLookup,
  seenPhones: Set<string> = new Set(),
): ImportRowDto {
  const errors: string[] = [];
  if (Object.values(row).some(isFormulaInjectionRisk)) errors.push('Formula-like values are not allowed.');

  const firstName = cleanString(getField(row, 'first_name', 'firstname', 'first name'));
  const lastName = cleanString(getField(row, 'last_name', 'lastname', 'last name'));
  const rawPhone = cleanString(getField(row, 'phone', 'mobile', 'phone_number'));
  const ministryGroup = cleanString(getField(row, 'ministry_group', 'group', 'ministry')) || 'General';

  const birthday = parseBirthdayString(getField(row, 'birthday', 'date_of_birth', 'dob'));
  const birthMonth = birthday?.month ?? optionalNumber(getField(row, 'birth_month', 'month'));
  const birthDay = birthday?.day ?? optionalNumber(getField(row, 'birth_day', 'day'));
  const birthYear = birthday?.year ?? optionalNumber(getField(row, 'birth_year', 'year'));

  if (firstName.length < 2) errors.push('First name is required.');
  if (lastName.length < 2) errors.push('Last name is required.');

  const phone = normalizeNigerianPhone(rawPhone);
  if (!phone) errors.push('Valid mobile phone is required.');
  if (!isValidMonthDay(birthMonth, birthDay)) errors.push('A valid birthday month/day or birthday date is required.');
  if (birthYear !== null && (birthYear < 1900 || birthYear > new Date().getFullYear())) {
    errors.push('Birth year is outside the accepted range.');
  }

  let duplicate: ImportRowDto['duplicate'] = null;
  if (phone) {
    if (seenPhones.has(phone)) errors.push('Duplicate phone number within this upload.');
    else seenPhones.add(phone);
    duplicate = lookupDuplicate(phone);
  }

  return {
    rowNumber,
    firstName,
    lastName,
    preferredName: cleanString(getField(row, 'preferred_name', 'preferredname')) || null,
    phone,
    birthMonth,
    birthDay,
    birthYear,
    ministryGroup,
    status: 'active',
    birthdayAlertAllowed: true,
    valid: errors.length === 0,
    errors,
    duplicate,
  };
}

export interface ImportAssessment {
  rows: ImportRowDto[];
  summary: { total: number; ready: number; invalid: number; duplicates: number };
}

export function assessImportRows(records: CsvRecord[], lookupDuplicate: DuplicateLookup): ImportAssessment {
  const seenPhones = new Set<string>();
  const rows = records.map((record, index) => buildImportRow(record, index + 2, lookupDuplicate, seenPhones));
  return {
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((row) => row.valid && !row.duplicate).length,
      invalid: rows.filter((row) => !row.valid).length,
      duplicates: rows.filter((row) => row.duplicate).length,
    },
  };
}
