/**
 * Presentation-safe masking helpers.
 *
 * Personally identifying data leaves the server only in these masked forms,
 * unless the requesting role is explicitly allowed to reveal it.
 */

export function maskedEmail(email: string | null | undefined): string {
  const value = String(email ?? '').trim();
  const [local, domain] = value.split('@');
  if (!local || !domain) return 'invited staff member';
  const visibleLength = Math.min(2, local.length);
  const visible = local.slice(0, visibleLength);
  const hidden = '•'.repeat(Math.max(1, local.length - visibleLength));
  return `${visible}${hidden}@${domain}`;
}

export function truncated(value: string | null | undefined, maxLength = 500): string {
  return String(value ?? '').slice(0, maxLength);
}
