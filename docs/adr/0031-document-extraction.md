# ADR-0031: Document extraction — PDFs, DOCX and text as anchored evidence

**Status:** Accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0011, ADR-0016, ADR-0025, ADR-0030

## Context

Research discovery routinely surfaces PDFs: regulator filings, standards, analyst reports,
academic papers — often the most authoritative material in a vertical. The pipeline could fetch
them but not read them. ADR-0025 recorded the gap honestly (`snippetOnly` with a stated reason)
and ADR-0030 down-weighted such sources, which was correct but left the best evidence permanently
weakest.

A naive fix — run a PDF through a text extractor and append the result to the existing text field
— would produce a citation that points at a 200-page document and nothing more precise. That is a
decorative citation: it names a document without letting anyone check the claim.

## Decision

Extract documents into text **with citation anchors**, behind a port, with limits and injection
scanning enforced before anything downstream.

1. **`DocumentExtractionProvider` port (research-core).** `supports(mime, filename)` plus
   `extract(input, tenant) → { ok: true, document } | { ok: false, failure }`. Failures are
   **returned, not thrown**, so the pipeline keeps the source with a truthful reason instead of
   dropping it or degrading it to an unexplained snippet.

2. **Anchors are the reason this exists.** `DocumentCitationAnchor` carries a character range into
   the extracted text (so the exact passage can be re-read) plus the human locator for the format:
   page for PDF, section for DOCX/Markdown, line range for plain text. `unpdf` (pdf.js) is used
   with `mergePages: false` specifically so each page survives as its own anchor. `Citation` gains
   `anchorKind`, `pageNumber`, `sectionOrder`, `anchorLabel`.

3. **Limits before parsers.** MIME allow-list and per-type size caps are checked before any bytes
   reach a parser, because a document parser is the largest attack surface added here. Legacy
   binary `.doc` is rejected explicitly rather than fed to the OOXML parser. Filenames are stripped
   of directory components, so a crafted name can never become a path segment.

4. **Extracted text is untrusted.** It runs through the same `scanForPromptInjection` as scraped
   web pages and is wrapped by `wrapUntrustedContent()` before reaching any prompt. **A PDF is not
   more trustworthy than a web page** — arguably less, since a document is a convenient carrier
   for hidden instructions.

5. **No OCR.** A scanned PDF with no text layer fails with `NO_TEXT_LAYER` and a message saying
   OCR was not attempted. Guessing at image text would manufacture evidence; saying we cannot read
   it is the honest outcome, and the source stays as a snippet.

6. **Partial is never complete.** A PDF whose pages yield no text fails outright; one where _some_
   pages are empty succeeds and carries warnings naming how many pages are missing.

7. **Budgets and tenancy unchanged.** Extraction is first-party work with no vendor charge, so it
   is metered `DOCUMENT_EXTRACTION` as counter-only (bounded by per-kind limits, never priced as a
   fake zero cost — ADR-0028). Embeddings of extracted text still run behind the existing budget
   pre-flight. Extraction is tenant-scoped like every other pipeline step; nothing crosses
   workspaces.

## Rationale

- **Page anchors or nothing.** Without them the honest move would have been to leave PDFs as
  snippets. A citation that cannot be checked is worse than an acknowledged gap.
- **Failures as values.** Every failure code (`UNSUPPORTED_MIME`, `FILE_TOO_LARGE`, `ENCRYPTED`,
  `CORRUPT`, `NO_TEXT_LAYER`, `PARSER_ERROR`) is a distinct, displayable fact. Collapsing them into
  "couldn't read it" would hide that, for instance, the operator's own size cap was the cause.
- **Declared type, not sniffed.** We act on the served Content-Type, falling back to the filename
  extension. Sniffing bytes would mean parsing something the source never claimed it was.
- **Parser errors are summarised.** A parser message can echo document content, so it is replaced
  with a generic one — extracted private document text must never reach logs.

## Consequences

- PDFs/DOCX/TXT discovered by search become full-strength evidence with page-level citations,
  instead of permanently down-weighted snippets.
- New third-party parsing dependencies (`unpdf`, `mammoth`) sit on untrusted input. Size/MIME
  limits bound the exposure; sandboxing the parsers is not done and would be the next hardening
  step if untrusted documents grow in volume.
- Scanned documents remain unusable. This is deliberate, and visible in the UI as
  `extraction: no text layer`.
- Anchors index into the extracted text, not the original file's byte layout. Re-extracting with a
  different parser version could shift offsets; the page/section locator remains stable, which is
  why both are stored.
- Extraction is synchronous inside discovery and bounded by the existing per-run fetch budget and
  concurrency limits. A very large PDF will consume one fetch slot for longer than a web page.
- Uploaded (as opposed to discovered) documents reuse the same provider but are not yet wired to
  an upload endpoint — the port and limits are ready for it.
