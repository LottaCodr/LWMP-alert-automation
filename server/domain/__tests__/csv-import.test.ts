import { describe, expect, it } from 'vitest';
import {
  assessImportRows,
  buildImportRow,
  getField,
  isFormulaInjectionRisk,
  parseBirthdayString,
} from '../csv-import.js';

const noDuplicates = () => null;

describe('parseBirthdayString', () => {
  it('reads ISO dates', () => {
    expect(parseBirthdayString('1992-09-14')).toEqual({ year: 1992, month: 9, day: 14 });
  });

  it('reads Nigerian day/month ordering with or without a year', () => {
    expect(parseBirthdayString('14/09/1992')).toEqual({ day: 14, month: 9, year: 1992 });
    expect(parseBirthdayString('14-09')).toEqual({ day: 14, month: 9, year: null });
  });

  it('returns null for unusable values', () => {
    expect(parseBirthdayString('')).toBeNull();
    expect(parseBirthdayString('unknown')).toBeNull();
    expect(parseBirthdayString(undefined)).toBeNull();
  });
});

describe('getField', () => {
  const row = { 'First Name': 'Ada', LAST_NAME: 'Okafor', 'phone-number': '08031111001' };

  it('ignores case, spaces, dashes and underscores across every listed alias', () => {
    expect(getField(row, 'first_name')).toBe('Ada');
    expect(getField(row, 'lastName')).toBe('Okafor');
    // The caller lists the aliases it accepts, exactly as `buildImportRow` does.
    expect(getField(row, 'phone', 'mobile', 'phone_number')).toBe('08031111001');
  });

  it('does not guess aliases that were not listed', () => {
    expect(getField(row, 'phone')).toBeUndefined();
  });

  it('returns undefined when no alias matches', () => {
    expect(getField(row, 'email')).toBeUndefined();
  });
});

describe('isFormulaInjectionRisk', () => {
  it('flags spreadsheet formula prefixes', () => {
    expect(isFormulaInjectionRisk('=CMD()')).toBe(true);
    expect(isFormulaInjectionRisk('+1 234')).toBe(true);
    expect(isFormulaInjectionRisk('@SUM(A1)')).toBe(true);
    expect(isFormulaInjectionRisk('-2')).toBe(true);
  });

  it('accepts ordinary text', () => {
    expect(isFormulaInjectionRisk('Ada')).toBe(false);
    expect(isFormulaInjectionRisk('08031111001')).toBe(false);
  });
});

describe('buildImportRow', () => {
  it('accepts a complete row', () => {
    const row = buildImportRow(
      {
        first_name: 'Ada',
        last_name: 'Okafor',
        phone: '08031111001',
        birthday: '14/09/1992',
        ministry_group: 'Welcome',
      },
      2,
      noDuplicates,
    );
    expect(row.valid).toBe(true);
    expect(row.errors).toEqual([]);
    expect(row.phone).toBe('+2348031111001');
    expect(row.birthMonth).toBe(9);
    expect(row.birthDay).toBe(14);
    expect(row.birthYear).toBe(1992);
    expect(row.ministryGroup).toBe('Welcome');
  });

  it('defaults the ministry group to General', () => {
    const row = buildImportRow(
      { first_name: 'Ada', last_name: 'Okafor', phone: '08031111001', birth_month: 9, birth_day: 14 },
      2,
      noDuplicates,
    );
    expect(row.ministryGroup).toBe('General');
  });

  it('collects every validation problem at once', () => {
    const row = buildImportRow({ first_name: 'A', last_name: '', phone: 'nope', birthday: '31/02' }, 3, noDuplicates);
    expect(row.valid).toBe(false);
    expect(row.errors).toEqual([
      'First name is required.',
      'Last name is required.',
      'Valid mobile phone is required.',
      'A valid birthday month/day or birthday date is required.',
    ]);
  });

  it('rejects formula-injected cells', () => {
    const row = buildImportRow(
      {
        first_name: '=HYPERLINK("http://x")',
        last_name: 'Okafor',
        phone: '08031111001',
        birth_month: 9,
        birth_day: 14,
      },
      2,
      noDuplicates,
    );
    expect(row.valid).toBe(false);
    expect(row.errors).toContain('Formula-like values are not allowed.');
  });

  it('rejects birth years outside the accepted range', () => {
    const row = buildImportRow(
      { first_name: 'Ada', last_name: 'Okafor', phone: '08031111001', birth_month: 9, birth_day: 14, birth_year: 1850 },
      2,
      noDuplicates,
    );
    expect(row.errors).toContain('Birth year is outside the accepted range.');
  });

  it('flags duplicates already stored and duplicates inside the same file', () => {
    const lookup = (phone: string) =>
      phone === '+2348031111001' ? { memberCode: 'LW-1', fullName: 'Ada Okafor' } : null;
    const stored = buildImportRow(
      { first_name: 'Ada', last_name: 'Okafor', phone: '08031111001', birth_month: 9, birth_day: 14 },
      2,
      lookup,
    );
    expect(stored.duplicate).toEqual({ memberCode: 'LW-1', fullName: 'Ada Okafor' });

    const seen = new Set<string>();
    const first = buildImportRow(
      { first_name: 'Ada', last_name: 'Okafor', phone: '08031111002', birth_month: 9, birth_day: 14 },
      2,
      noDuplicates,
      seen,
    );
    const second = buildImportRow(
      { first_name: 'Ada', last_name: 'Okafor', phone: '08031111002', birth_month: 9, birth_day: 14 },
      3,
      noDuplicates,
      seen,
    );
    expect(first.valid).toBe(true);
    expect(second.errors).toContain('Duplicate phone number within this upload.');
  });
});

describe('assessImportRows', () => {
  it('summarises ready, invalid and duplicate rows', () => {
    const assessment = assessImportRows(
      [
        { first_name: 'Ada', last_name: 'Okafor', phone: '08031111001', birth_month: 9, birth_day: 14 },
        { first_name: 'Bad', last_name: 'Row', phone: 'nope', birth_month: 9, birth_day: 14 },
        { first_name: 'Ada', last_name: 'Okafor', phone: '08031111001', birth_month: 9, birth_day: 14 },
      ],
      (phone) => (phone === '+2348031111001' ? { memberCode: 'LW-1', fullName: 'Ada Okafor' } : null),
    );
    // Row 4 repeats a phone already seen in the same upload, so it is counted as
    // both invalid (it carries an error) and a duplicate candidate.
    expect(assessment.summary).toEqual({ total: 3, ready: 0, invalid: 2, duplicates: 2 });
    expect(assessment.rows[0]?.rowNumber).toBe(2);
    expect(assessment.rows[0]?.valid).toBe(true);
    expect(assessment.rows[0]?.duplicate).toEqual({ memberCode: 'LW-1', fullName: 'Ada Okafor' });
    expect(assessment.rows[1]?.errors).toContain('Valid mobile phone is required.');
    expect(assessment.rows[2]?.errors).toContain('Duplicate phone number within this upload.');
  });

  it('counts clean rows as ready', () => {
    const assessment = assessImportRows(
      [{ first_name: 'Ada', last_name: 'Okafor', phone: '08031111001', birthday: '14/09' }],
      noDuplicates,
    );
    expect(assessment.summary.ready).toBe(1);
  });
});
