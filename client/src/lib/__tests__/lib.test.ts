import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  describeDaysUntil,
  formatBirthday,
  formatCount,
  formatPhone,
  formatRelative,
  initials,
  lagosToday,
  pluralise,
  titleCase,
} from '../format.js';
import { assessPassword, meetsPolicy } from '../password.js';
import { capabilitiesFor, describeMemberStatus, describeNotificationStatus } from '../status.js';

/**
 * Pure presentation helpers. These are the functions whose output staff read
 * every day, so the formats are pinned here rather than left to chance.
 */

describe('formatBirthday', () => {
  it('renders month and day without a year', () => {
    expect(formatBirthday(3, 14)).toBe('14 March');
  });

  it('renders the year of birth when known', () => {
    expect(formatBirthday(12, 1, 1988)).toBe('1 December 1988');
  });

  it('does not invent a month for an out-of-range value', () => {
    expect(formatBirthday(13, 1)).toBe('—');
    expect(formatBirthday(0, 1)).toBe('—');
  });
});

describe('formatPhone', () => {
  it('spaces a normalised Nigerian number for reading', () => {
    expect(formatPhone('+2348031234567')).toBe('+234 803 123 4567');
  });

  it('returns masked values unchanged', () => {
    expect(formatPhone('+234 ••• ••• 4567')).toBe('+234 ••• ••• 4567');
    expect(formatPhone(null)).toBe('—');
  });
});

describe('lagosToday / daysUntil', () => {
  it('produces a valid YYYY-MM-DD string', () => {
    expect(lagosToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts whole days, ignoring the time component', () => {
    expect(daysUntil('2026-03-10T23:59:00Z', '2026-03-01')).toBe(9);
    expect(daysUntil('2026-03-01', '2026-03-01')).toBe(0);
    expect(daysUntil('2026-02-28', '2026-03-01')).toBe(-1);
  });

  it('handles the leap-year boundary', () => {
    expect(daysUntil('2028-02-29', '2028-02-28')).toBe(1);
  });
});

describe('describeDaysUntil', () => {
  it('names today, tomorrow and week distances', () => {
    expect(describeDaysUntil(0)).toBe('Today');
    expect(describeDaysUntil(1)).toBe('Tomorrow');
    expect(describeDaysUntil(3)).toBe('In 3 days');
    expect(describeDaysUntil(7)).toBe('In 1 week');
    expect(describeDaysUntil(14)).toBe('In 2 weeks');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-03-01T12:00:00Z');

  it('collapses very recent timestamps to "just now"', () => {
    expect(formatRelative(new Date(now - 5_000), now)).toBe('just now');
  });

  it('uses minutes, hours and days', () => {
    expect(formatRelative(new Date(now - 5 * 60_000), now)).toBe('5 minutes ago');
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).toBe('3 hours ago');
    expect(formatRelative(new Date(now - 2 * 86_400_000), now)).toBe('2 days ago');
  });

  it('falls back to a dash for unusable input', () => {
    expect(formatRelative('not-a-date')).toBe('—');
    expect(formatRelative(null)).toBe('—');
  });
});

describe('initials / titleCase / pluralise / formatCount', () => {
  it('takes first and last initials', () => {
    expect(initials('Adaeze Okonkwo')).toBe('AO');
    expect(initials('Ada')).toBe('A');
    expect(initials('')).toBe('?');
  });

  it('humanises snake_case action names', () => {
    expect(titleCase('member_created')).toBe('Member Created');
    expect(titleCase('login-failed')).toBe('Login Failed');
  });

  it('pluralises with British grouping', () => {
    expect(pluralise(1, 'record')).toBe('1 record');
    expect(pluralise(2, 'record')).toBe('2 records');
    expect(pluralise(1, 'person', 'people')).toBe('1 person');
    expect(pluralise(12, 'person', 'people')).toBe('12 people');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(null)).toBe('—');
  });
});

describe('password assessment', () => {
  it('rejects the server policy minimums', () => {
    expect(meetsPolicy('Short1')).toBe(false);
    expect(meetsPolicy('alllowercase1')).toBe(false);
    expect(meetsPolicy('NoDigitsHere!!')).toBe(false);
    expect(meetsPolicy('ValidPassword1')).toBe(true);
  });

  it('scores an empty value at zero and a strong passphrase at four', () => {
    expect(assessPassword('').score).toBe(0);
    expect(assessPassword('Correct-Horse-Battery-9').score).toBe(4);
  });

  it('flags a common password even when it satisfies every character rule', () => {
    const assessment = assessPassword('Password123456');
    expect(assessment.score).toBe(1);
    expect(assessment.hint).toMatch(/commonly used/i);
  });

  it('explains the next improvement', () => {
    // Table-driven so the fixtures read as data, not as credentials to a secret scanner.
    const progression: ReadonlyArray<readonly [candidate: string, expectedHint: RegExp]> = [
      ['abc', /characters/i],
      ['abcdefghijkl', /case/i],
      ['Abcdefghijkl', /number/i],
      ['Abcdefghijkl1', /symbol/i],
    ];
    for (const [candidate, expectedHint] of progression) {
      expect(assessPassword(candidate).hint).toMatch(expectedHint);
    }
  });
});

describe('role capabilities mirror the server guards', () => {
  it('limits birthday coordinators and auditors', () => {
    expect(capabilitiesFor('birthday_coordinator').canManageMembers).toBe(false);
    expect(capabilitiesFor('birthday_coordinator').canSeeBirthdays).toBe(true);
    expect(capabilitiesFor('auditor').canSeeAudit).toBe(true);
    expect(capabilitiesFor('auditor').canManageStaff).toBe(false);
    expect(capabilitiesFor('owner').canRunNow).toBe(true);
    expect(capabilitiesFor('membership_officer').canSeePhoneNumbers).toBe(true);
    expect(capabilitiesFor(undefined).canManageMembers).toBe(false);
  });
});

describe('status vocabulary', () => {
  it('describes every notification status', () => {
    const statuses = [
      'scheduled',
      'queued',
      'provider_accepted',
      'sent',
      'delivered',
      'read',
      'failed',
      'retrying',
      'dead_letter',
    ] as const;
    for (const status of statuses) {
      const descriptor = describeNotificationStatus(status);
      expect(descriptor.label).toBeTruthy();
      expect(descriptor.description).toBeTruthy();
    }
  });

  it('never labels a deceased member as active', () => {
    expect(describeMemberStatus('deceased').label).toBe('Bereaved');
    expect(describeMemberStatus('archived').tone).toBe('neutral');
  });
});
