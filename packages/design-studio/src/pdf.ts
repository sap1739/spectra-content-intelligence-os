/**
 * A minimal, dependency-free PDF writer for rendered pages (ADR-0040).
 *
 * sharp cannot write PDF, so each page is embedded as the JPEG the renderer
 * produced (DCTDecode — the image bytes go in unchanged) on a page sized from
 * the format's dpi. The result is a real, standards-conforming PDF 1.4: a
 * raster export of exactly the pixels that were rendered, not a vector
 * document, and it says so wherever it is offered.
 */

export interface PdfPage {
  /** Baseline or progressive JPEG, RGB. */
  jpeg: Buffer;
  widthPx: number;
  heightPx: number;
}

function points(px: number, dpi: number): string {
  return ((px * 72) / dpi).toFixed(2);
}

export function buildImagePdf(pages: readonly PdfPage[], dpi: number): Buffer {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Buffer | string) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    chunks.push(buffer);
    length += buffer.length;
  };
  const object = (id: number, body: () => void) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  // Object ids: 1 catalog, 2 pages, then 3 per page (page, content, image).
  const pageId = (index: number) => 3 + index * 3;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () =>
    push(
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ),
  );
  pages.forEach((page, index) => {
    const id = pageId(index);
    const w = points(page.widthPx, dpi);
    const h = points(page.heightPx, dpi);
    object(id, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
      ),
    );
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(id + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    object(id + 2, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      );
      push(page.jpeg);
      push('\nendstream');
    });
  });

  const count = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id += 1) {
    push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
