import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone-number handling for Nigerian member and administrator endpoints.
 *
 * Members may enter `0803 000 0000` or `+234 803 000 0000`; everything is
 * normalised to E.164 before encryption so lookups and provider calls are
 * consistent. These helpers are pure: the HTTP layer decides how a `null`
 * becomes a 422 response.
 */

export const DEFAULT_REGION = 'NG';

export function normalizeNigerianPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_REGION);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** Provider payloads want digits only, without a leading `+`. */
export function providerPhoneDigits(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length ? digits : null;
}

/** `+2348031111001` -> `•••• 1001`. Never returns the full number. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `•••• ${phone.slice(-4)}`;
}
