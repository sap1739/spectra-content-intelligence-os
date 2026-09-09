import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * Deterministic document fixtures, built in code rather than committed as
 * binaries — the repository keeps no opaque test blobs, and a generated fixture
 * makes the exact structure under test readable.
 *
 * Exported (not test-only) so integration tests in other packages can build the
 * same documents.
 */

/** A valid PDF with a real text layer, one text run per page. */
export function buildPdf(
  pages: readonly string[],
  meta: { title?: string; author?: string; creationDate?: string } = {},
): Buffer {
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: string[] = [];

  const pageObjNumbers: number[] = [];
  // 1 = Catalog, 2 = Pages, then (page, content) pairs, then font, then info.
  let next = 3;
  for (let i = 0; i < pages.length; i += 1) {
    pageObjNumbers.push(next);
    next += 2;
  }
  const fontObj = next;
  const infoObj = next + 1;

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageObjNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;

  pages.forEach((pageText, i) => {
    const pageNum = pageObjNumbers[i] as number;
    const contentNum = pageNum + 1;
    objects[pageNum - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`;
    const stream = `BT /F1 14 Tf 72 700 Td (${escape(pageText)}) Tj ET`;
    objects[contentNum - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontObj - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const infoParts = [
    meta.title ? `/Title (${escape(meta.title)})` : '',
    meta.author ? `/Author (${escape(meta.author)})` : '',
    meta.creationDate ? `/CreationDate (${meta.creationDate})` : '',
  ].filter(Boolean);
  objects[infoObj - 1] = `<< ${infoParts.join(' ')} >>`;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = body.length;
  const size = objects.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A PDF with pages but no text operators — stands in for a scanned document. */
export function buildImageOnlyPdf(pageCount = 2): Buffer {
  return buildPdf(Array.from({ length: pageCount }, () => ''));
}

export interface DocxBlock {
  heading?: string;
  level?: number;
  paragraphs?: string[];
}

/** A valid minimal OOXML .docx with headings and paragraphs. */
export function buildDocx(blocks: readonly DocxBlock[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras: string[] = [];
  for (const block of blocks) {
    if (block.heading) {
      paras.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${block.level ?? 1}"/></w:pPr>` +
          `<w:r><w:t>${esc(block.heading)}</w:t></w:r></w:p>`,
      );
    }
    for (const p of block.paragraphs ?? []) {
      paras.push(`<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`);
    }
  }
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paras.join('')}</w:body></w:document>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Minimal deflate ZIP writer — enough for a valid OOXML package. */
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}
