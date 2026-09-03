import { describe, expect, it } from 'vitest';
import { endpointVerificationMessage, messageForDigest, messageForTest } from '../messaging.js';

const birthday = { year: 2026, month: 9, day: 14 };

describe('messageForDigest', () => {
  it('pluralises the count correctly', () => {
    expect(messageForDigest(1, birthday)).toContain('1 authorised birthday is due');
    expect(messageForDigest(4, birthday)).toContain('4 authorised birthdays are due');
  });

  it('describes the day itself without a lead time', () => {
    const message = messageForDigest(3, birthday, 0);
    expect(message).toContain('on ');
    expect(message).toContain('14 September 2026');
  });

  it('describes the lead time in days', () => {
    expect(messageForDigest(3, birthday, 1)).toContain('in 1 day');
    expect(messageForDigest(3, birthday, 7)).toContain('in 7 days');
  });

  it('never embeds member names, phones or the raw date of birth pattern', () => {
    const message = messageForDigest(2, birthday, 0);
    expect(message).not.toMatch(/\+234/);
    expect(message).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(message).toContain('Sign in to the Living Water private dashboard');
  });
});

describe('messageForTest', () => {
  it('names the channel and carries no member data', () => {
    expect(messageForTest('whatsapp')).toContain('WhatsApp');
    expect(messageForTest('sms')).toContain('SMS');
    expect(messageForTest('sms')).toContain('No member data is included.');
  });
});

describe('endpointVerificationMessage', () => {
  it('includes the code and an expiry warning', () => {
    const message = endpointVerificationMessage('123456');
    expect(message).toContain('123456');
    expect(message).toContain('expires in 10 minutes');
    expect(message).toContain('Do not share this code');
  });
});
