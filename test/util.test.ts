import { describe, expect, it } from 'vitest';
import { daysBetween, escapeHtml, formatDuration, jitteredDelay, nameMatches, parseDuration, statusMatches } from '../src/util.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500], ['30s', 30_000], ['5m', 300_000], ['2h', 7_200_000], ['1d', 86_400_000], ['1.5s', 1500], [250, 250], [' 10 s ', 10_000],
  ])('parses %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });
  it.each([['abc'], ['10'], ['-5s'], [-1], [NaN], [null], [{}]])('rejects %s', (input) => {
    expect(() => parseDuration(input)).toThrow(/Invalid/);
  });
});

describe('jitteredDelay', () => {
  it('stays within the jitter band', () => {
    expect(jitteredDelay(10_000, 0.1, () => 0)).toBe(9000);
    expect(jitteredDelay(10_000, 0.1, () => 0.5)).toBe(10_000);
    expect(jitteredDelay(10_000, 0.1, () => 1)).toBe(11_000);
  });
  it('is exact with no jitter and never below 1ms', () => {
    expect(jitteredDelay(5000, 0, () => 0.9)).toBe(5000);
    expect(jitteredDelay(1, 1, () => 0)).toBe(1);
  });
  it('varies with the random source', () => {
    const delays = new Set([0.1, 0.4, 0.8].map((r) => jitteredDelay(60_000, 0.2, () => r)));
    expect(delays.size).toBe(3);
  });
});

describe('nameMatches', () => {
  it.each([
    ['example.com', 'example.com', true],
    ['EXAMPLE.com', 'example.COM', true],
    ['*.example.com', 'www.example.com', true],
    ['*.example.com', 'example.com', false],
    ['*.example.com', 'a.b.example.com', false],
    ['example.com', 'www.example.com', false],
    ['*.example.com', 'evilexample.com', false],
  ])('%s vs %s = %s', (pattern, host, expected) => {
    expect(nameMatches(pattern, host)).toBe(expected);
  });
});

describe('statusMatches', () => {
  it.each([
    [200, [200], true], [201, [200], false], [204, ['2xx'], true], [301, ['2xx', '3xx'], true],
    [404, ['2xx', '3xx'], false], [503, ['5xx'], true], [404, [404, 410], true], [200, ['2XX'], true],
  ] as const)('%s in %j = %s', (code, spec, expected) => {
    expect(statusMatches(code, [...spec])).toBe(expected);
  });
});

describe('misc helpers', () => {
  it('daysBetween floors and goes negative', () => {
    expect(daysBetween(0, 86_400_000 * 3 + 5)).toBe(3);
    expect(daysBetween(86_400_000, 0)).toBe(-1);
  });
  it.each([[450, '450ms'], [5000, '5s'], [125_000, '2m 5s'], [7_500_000, '2h 5m'], [200_000_000, '2d 7h']])('formatDuration(%s)', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
  it('escapeHtml escapes markup characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
