import { describe, expect, it } from 'vitest';

import {
  credibilityScore,
  domainOf,
  freshnessScore,
  sourceDiversityScore,
  velocityScore,
} from './signals';

const NOW = new Date('2026-07-07T00:00:00Z');

describe('freshnessScore', () => {
  it('decays with age: fresh ≈ 1, half-life ≈ 0.5, old → 0', () => {
    expect(freshnessScore(NOW, NOW)).toBeCloseTo(1, 5);
    expect(freshnessScore(new Date('2026-06-30T00:00:00Z'), NOW)).toBeCloseTo(0.5, 2);
    expect(freshnessScore(new Date('2026-01-01T00:00:00Z'), NOW)).toBeLessThan(0.01);
  });

  it('uses a conservative prior when the date is unknown', () => {
    expect(freshnessScore(null, NOW)).toBe(0.3);
  });
});

describe('velocityScore', () => {
  it('maps steady flow to ~0.5 and a recent burst to 1', () => {
    expect(velocityScore(0, 10)).toBe(0);
    expect(velocityScore(7, 30)).toBeCloseTo(0.5, 1);
    expect(velocityScore(10, 10)).toBe(1);
  });
});

describe('sourceDiversityScore', () => {
  it('rewards distinct publishers up to a cap', () => {
    expect(sourceDiversityScore(1, 10)).toBeCloseTo(0.2, 5);
    expect(sourceDiversityScore(5, 10)).toBe(1);
    expect(sourceDiversityScore(2, 2)).toBe(1);
    expect(sourceDiversityScore(0, 0)).toBe(0);
  });
});

describe('credibilityScore', () => {
  it('boosts trusted domains including subdomains', () => {
    expect(credibilityScore('example.com', ['example.com'])).toBe(0.9);
    expect(credibilityScore('blog.example.com', ['example.com'])).toBe(0.9);
    expect(credibilityScore('unknown.net', ['example.com'])).toBe(0.5);
  });
});

describe('domainOf', () => {
  it('lowercases and strips www', () => {
    expect(domainOf('https://WWW.Example.COM/x')).toBe('example.com');
    expect(domainOf('not a url')).toBe('unknown');
  });
});
