import { describe, expect, it } from 'vitest';

import { UnsafeUrlError, assertSafeUrl } from './safe-fetch';

describe('assertSafeUrl (SSRF containment)', () => {
  it('accepts public http(s) URLs', () => {
    expect(assertSafeUrl('https://example.com/feed.xml').hostname).toBe('example.com');
    expect(assertSafeUrl('http://news.example.org/rss').protocol).toBe('http:');
  });

  it('rejects non-http protocols', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('ftp://example.com/x')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('gopher://example.com')).toThrow(UnsafeUrlError);
  });

  it('rejects loopback, private and metadata addresses', () => {
    for (const url of [
      'http://localhost/feed',
      'http://127.0.0.1/feed',
      'http://10.0.0.5/feed',
      'http://192.168.1.1/feed',
      'http://172.16.0.9/feed',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.1.2/x',
      'http://[::1]/feed',
      'http://[fd00::1]/feed',
      'http://internal.local/feed',
      'http://metadata.google.internal/x',
    ]) {
      expect(() => assertSafeUrl(url), url).toThrow(UnsafeUrlError);
    }
  });

  it('rejects credentials embedded in URLs', () => {
    expect(() => assertSafeUrl('https://user:pass@example.com/')).toThrow(UnsafeUrlError);
  });

  it('allows private hosts only with the explicit test escape hatch', () => {
    expect(assertSafeUrl('http://127.0.0.1:8080/feed', true).port).toBe('8080');
  });
});
