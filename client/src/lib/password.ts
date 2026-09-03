/**
 * Client-side password assessment.
 *
 * The server remains the authority (it rejects anything under 12 characters or
 * missing a character class); this only gives the person typing immediate,
 * actionable feedback instead of a rejection after a round trip.
 */

export interface PasswordAssessment {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  met: Array<{ id: string; label: string; ok: boolean }>;
  hint: string | null;
}

const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  'password1234',
  'qwerty123456',
  'administrator',
  'welcome123',
  'letmein12345',
  'livingwater2026',
]);

/** Words that stay weak whatever digits are appended ("Password123456"). */
const COMMON_BASES = new Set([
  'password',
  'passwort',
  'qwerty',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'livingwater',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'monkey',
  'dragon',
]);

function looksCommon(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (COMMON_PASSWORDS.has(normalized)) return true;
  const withoutTrailingDigits = normalized.replace(/\d+$/, '');
  return withoutTrailingDigits.length >= 6 && COMMON_BASES.has(withoutTrailingDigits);
}

export function assessPassword(value: string): PasswordAssessment {
  const met: PasswordAssessment['met'] = [
    { id: 'length', label: 'At least 12 characters', ok: value.length >= 12 },
    { id: 'case', label: 'Upper and lower case letters', ok: /[a-z]/.test(value) && /[A-Z]/.test(value) },
    { id: 'number', label: 'At least one number', ok: /\d/.test(value) },
    { id: 'variety', label: 'A symbol or extra characters', ok: /[^A-Za-z0-9]/.test(value) || value.length >= 16 },
  ];

  const satisfied = met.filter((rule) => rule.ok).length;
  const required = met.slice(0, 3).every((rule) => rule.ok);
  const weak = looksCommon(value);

  const score: PasswordAssessment['score'] =
    value.length === 0 ? 0 : !required || weak ? 1 : satisfied === 3 ? 2 : satisfied === 4 && value.length < 16 ? 3 : 4;

  const labels: Record<PasswordAssessment['score'], string> = {
    0: 'Too short',
    1: 'Too weak',
    2: 'Acceptable',
    3: 'Strong',
    4: 'Very strong',
  };
  const hint = !met[0]?.ok
    ? 'Add a few more characters — 12 is the minimum.'
    : !met[1]?.ok
      ? 'Mix upper and lower case letters.'
      : !met[2]?.ok
        ? 'Add at least one number.'
        : weak
          ? 'This looks like a commonly used password. Choose something only you would guess.'
          : satisfied < 4
            ? 'A symbol or a longer passphrase makes this harder to guess.'
            : null;

  return { score, label: labels[score], met, hint };
}

/** Server rule mirrored for inline validation: 12–128 chars with three classes. */
export function meetsPolicy(value: string): boolean {
  return value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}
