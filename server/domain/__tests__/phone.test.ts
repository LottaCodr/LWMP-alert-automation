import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeNigerianPhone, providerPhoneDigits } from '../phone.js';

describe('normalizeNigerianPhone', () => {
  it('normalises local Nigerian numbers to E.164', () => {
    expect(normalizeNigerianPhone('08031111001')).toBe('+2348031111001');
    expect(normalizeNigerianPhone('0803 111 1001')).toBe('+2348031111001');
  });

  it('accepts international format', () => {
    expect(normalizeNigerianPhone('+234 803 111 1001')).toBe('+2348031111001');
    expect(normalizeNigerianPhone('2348031111001')).toBe('+2348031111001');
  });

  it('rejects values that are not valid Nigerian mobile numbers', () => {
    expect(normalizeNigerianPhone('080311')).toBeNull();
    expect(normalizeNigerianPhone('not-a-number')).toBeNull();
    expect(normalizeNigerianPhone('')).toBeNull();
    expect(normalizeNigerianPhone(undefined)).toBeNull();
    expect(normalizeNigerianPhone(8031111001)).toBeNull();
  });
});

describe('providerPhoneDigits', () => {
  it('strips formatting for provider payloads', () => {
    expect(providerPhoneDigits('+2348031111001')).toBe('2348031111001');
  });

  it('returns null when there is nothing usable', () => {
    expect(providerPhoneDigits(null)).toBeNull();
    expect(providerPhoneDigits('+')).toBeNull();
  });
});

describe('maskPhone', () => {
  it('only ever reveals the last four digits', () => {
    expect(maskPhone('+2348031111001')).toBe('•••• 1001');
    expect(maskPhone('+2348031111001')).not.toContain('8031111');
  });

  it('returns null without a phone number', () => {
    expect(maskPhone(null)).toBeNull();
  });
});
