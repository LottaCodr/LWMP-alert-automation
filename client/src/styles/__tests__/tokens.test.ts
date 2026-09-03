import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Design-token accessibility tests.
 *
 * Every text/foreground pair the UI actually renders is asserted against
 * WCAG 2.2 AA here, so a palette change that drops a combination below 4.5:1
 * fails the build instead of shipping an unreadable screen. Non-text pairs
 * (input borders, focus indicators) use the 3:1 threshold from SC 1.4.11.
 */

const stylesheetPath = fileURLToPath(new URL('../tokens.css', import.meta.url));
const css = readFileSync(stylesheetPath, 'utf8');

/** Extract the declarations inside the first block that starts with `marker`. */
function declarationsAfter(marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  expect(start, `missing "${marker}" block in tokens.css`).toBeGreaterThan(-1);

  let index = css.indexOf('{', start);
  const bodyStart = index + 1;
  let depth = 0;
  for (; index < css.length; index += 1) {
    const character = css[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  const body = css.slice(bodyStart, index);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) tokens[name] = value.trim();
  }
  return tokens;
}

const light = declarationsAfter(':root {');
/**
 * The dark block only redeclares what changes, so lookups cascade over the
 * light tokens exactly as the browser does.
 */
const dark: Record<string, string> = { ...light, ...declarationsAfter(":root[data-theme='dark'] {") };
const darkOverrides = declarationsAfter(":root[data-theme='dark'] {");

function hexToChannels(value: string): [number, number, number] {
  const normalized = value.trim().replace('#', '');
  expect(normalized, `"${value}" is not a hex colour`).toMatch(/^[0-9a-f]{6}$/i);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance(value: string): number {
  const channels = hexToChannels(value).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  const red = channels[0] ?? 0;
  const green = channels[1] ?? 0;
  const blue = channels[2] ?? 0;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Text pairs: WCAG 2.2 SC 1.4.3 requires 4.5:1 for normal-size text. */
function assertTextPairs(palette: Record<string, string>, pairs: Array<[string, string, string]>): void {
  for (const [name, foregroundToken, backgroundToken] of pairs) {
    const foreground = palette[foregroundToken];
    const background = palette[backgroundToken];
    expect(foreground, `${foregroundToken} is undefined`).toBeTruthy();
    expect(background, `${backgroundToken} is undefined`).toBeTruthy();
    const ratio = contrastRatio(foreground as string, background as string);
    expect(ratio, `${name}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
}

/** Non-text pairs: WCAG 2.2 SC 1.4.11 requires 3:1 for boundaries and indicators. */
function assertNonTextPairs(palette: Record<string, string>, pairs: Array<[string, string, string]>): void {
  for (const [name, foregroundToken, backgroundToken] of pairs) {
    const foreground = palette[foregroundToken];
    const background = palette[backgroundToken];
    const ratio = contrastRatio(foreground as string, background as string);
    expect(ratio, `${name}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  }
}

describe('light theme', () => {
  it('keeps body and muted text above 4.5:1', () => {
    assertTextPairs(light, [
      ['ink on page', '--color-ink', '--color-page'],
      ['ink on surface', '--color-ink', '--color-surface'],
      ['muted ink on surface', '--color-ink-muted', '--color-surface'],
      ['muted ink on muted surface', '--color-ink-muted', '--color-surface-muted'],
      ['faint ink on surface', '--color-ink-faint', '--color-surface'],
      ['placeholder on surface', '--color-placeholder', '--color-surface'],
      ['link on surface', '--color-teal-700', '--color-surface'],
      ['eyebrow on surface', '--color-accent-text', '--color-surface'],
    ]);
  });

  it('keeps every semantic badge readable', () => {
    assertTextPairs(light, [
      ['success badge', '--color-success', '--color-success-bg'],
      ['warning badge', '--color-warning', '--color-warning-bg'],
      ['danger badge', '--color-danger', '--color-danger-bg'],
      ['info badge', '--color-info', '--color-info-bg'],
      ['neutral badge', '--color-neutral', '--color-neutral-bg'],
      ['accent badge', '--color-accent-text', '--color-accent-bg'],
      ['primary button label', '--color-inverse', '--color-teal-700'],
    ]);
  });

  it('keeps the sidebar readable on navy', () => {
    assertTextPairs(light, [
      ['sidebar heading', '--color-inverse-ink', '--color-navy-800'],
      ['sidebar item', '--color-inverse-ink-muted', '--color-navy-800'],
      ['sidebar brand on navy 900', '--color-inverse-ink', '--color-navy-900'],
      ['active item on navy 900', '--color-inverse', '--color-navy-900'],
    ]);
  });

  it('keeps borders and focus indicators above 3:1', () => {
    assertNonTextPairs(light, [
      ['input border', '--color-border-strong', '--color-surface'],
      ['focus ring', '--color-focus', '--color-surface'],
      ['focus ring on page', '--color-focus', '--color-page'],
    ]);
  });
});

describe('dark theme', () => {
  it('keeps body and muted text above 4.5:1', () => {
    assertTextPairs(dark, [
      ['ink on page', '--color-ink', '--color-page'],
      ['ink on surface', '--color-ink', '--color-surface'],
      ['muted ink on surface', '--color-ink-muted', '--color-surface'],
      ['muted ink on muted surface', '--color-ink-muted', '--color-surface-muted'],
      ['faint ink on surface', '--color-ink-faint', '--color-surface'],
      ['placeholder on surface', '--color-placeholder', '--color-surface'],
      ['link on surface', '--color-teal-400', '--color-surface'],
    ]);
  });

  it('keeps every semantic badge readable', () => {
    assertTextPairs(dark, [
      ['success badge', '--color-success', '--color-success-bg'],
      ['warning badge', '--color-warning', '--color-warning-bg'],
      ['danger badge', '--color-danger', '--color-danger-bg'],
      ['info badge', '--color-info', '--color-info-bg'],
      ['neutral badge', '--color-neutral', '--color-neutral-bg'],
      ['accent badge', '--color-accent-text', '--color-accent-bg'],
      ['primary button label on teal', '--color-inverse', '--color-teal-400'],
    ]);
  });

  it('keeps borders and focus indicators above 3:1', () => {
    assertNonTextPairs(dark, [
      ['input border', '--color-border-strong', '--color-surface'],
      ['focus ring', '--color-focus', '--color-surface'],
    ]);
  });
});

describe('token structure', () => {
  it('defines the same token names in both themes so nothing falls back unexpectedly', () => {
    const lightNames = new Set(Object.keys(light));
    const missing = Object.keys(darkOverrides).filter((name) => !lightNames.has(name));
    expect(missing).toEqual([]);
  });

  it('declares a colour scheme for both themes', () => {
    expect(css).toContain('color-scheme: light');
    expect(css).toContain('color-scheme: dark');
  });

  it('uses a 4px spacing grid', () => {
    for (const [name, value] of Object.entries(light)) {
      if (!name.startsWith('--space-')) continue;
      const rem = Number.parseFloat(value);
      expect(Number.isNaN(rem), `${name} is not a rem value`).toBe(false);
      expect((rem * 16) % 4, `${name} (${value}) is not on the 4px grid`).toBe(0);
    }
  });

  it('sets touch targets at or above the 24px WCAG minimum', () => {
    const target = light['--touch-target'];
    expect(target).toBeTruthy();
    expect(Number.parseFloat((target as string).replace('px', ''))).toBeGreaterThanOrEqual(24);
  });
});
