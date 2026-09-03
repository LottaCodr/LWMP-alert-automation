import { describe, expect, it } from 'vitest';
import { maskedEmail, truncated } from '../masking.js';

describe('maskedEmail', () => {
  it('keeps only the first two characters of the local part', () => {
    expect(maskedEmail('owner@livingwater.demo')).toBe('ow•••@livingwater.demo');
  });

  it('never exposes the full local part', () => {
    const masked = maskedEmail('membership@livingwater.demo');
    expect(masked).not.toContain('membership@');
    expect(masked).toContain('@livingwater.demo');
  });

  it('handles short local parts and single-character addresses', () => {
    expect(maskedEmail('a@b.co')).toBe('a•@b.co');
    expect(maskedEmail('ab@b.co')).toBe('ab•@b.co');
  });

  it('falls back to a neutral label without a domain', () => {
    expect(maskedEmail('not-an-email')).toBe('invited staff member');
    expect(maskedEmail('')).toBe('invited staff member');
    expect(maskedEmail(null)).toBe('invited staff member');
  });
});

describe('truncated', () => {
  it('caps stored error text', () => {
    expect(truncated('abcdef', 3)).toBe('abc');
    expect(truncated(null)).toBe('');
  });
});
