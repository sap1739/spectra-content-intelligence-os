import { describe, expect, it } from 'vitest';

import { decodeEntities, htmlToText } from './html-text';

describe('htmlToText', () => {
  it('strips tags, scripts and styles while keeping content', () => {
    const html = `
      <style>.x{color:red}</style>
      <script>alert('nope')</script>
      <h1>Heading</h1>
      <p>First <b>bold</b> paragraph.</p>
      <p>Second&nbsp;&amp;&nbsp;final.</p>`;
    const text = htmlToText(html);
    expect(text).toContain('Heading');
    expect(text).toContain('First bold paragraph.');
    expect(text).toContain('Second & final.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('<');
  });

  it('turns block boundaries into newlines', () => {
    const text = htmlToText('<p>one</p><p>two</p><br>three');
    expect(text.split('\n').map((l) => l.trim())).toEqual(['one', 'two', 'three']);
  });

  it('decodes numeric and named entities', () => {
    expect(decodeEntities('&#65;&#x42;&mdash;&rsquo;&unknown;')).toBe('AB—’&unknown;');
  });
});
