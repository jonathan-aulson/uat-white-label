import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFInvalidObject, PDFName, PDFNumber, PDFObject, PDFRef, PDFStream, PDFString } from 'pdf-lib';

// Minimal deterministic PDF writer (Helvetica, text only) and structural screening for uploaded PDFs.
export interface PdfSpec { title: string; subtitle?: string; rows: { label: string; value: string }[]; footer?: string; created: string }

const win = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
const esc = (s: string) => win(s).replace(/([\\()])/g, '\\$1');
function wrap(text: string, width: number): string[] {
 const out: string[] = [];
 for (const para of win(text).split(/\r?\n/)) {
  let line = '';
  for (const word of para.split(/\s+/)) {
   if (!word) continue;
   if ((line + ' ' + word).trim().length > width) { if (line) out.push(line); line = word; while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); } }
   else line = (line + ' ' + word).trim();
  }
  out.push(line);
 }
 return out;
}
export function generatePdf(spec: PdfSpec): Uint8Array {
 type Line = { text: string; size: number; bold?: boolean; gap?: number };
 const lines: Line[] = [{ text: 'SYNTHETIC TEST DOCUMENT - NOT A REAL RECORD', size: 9, bold: true, gap: 14 }, { text: spec.title, size: 18, bold: true, gap: 8 }];
 if (spec.subtitle) lines.push(...wrap(spec.subtitle, 85).map(t => ({ text: t, size: 11, gap: 0 })), { text: '', size: 8 });
 for (const r of spec.rows) {
  lines.push({ text: r.label, size: 9, bold: true, gap: 6 });
  lines.push(...wrap(r.value, 90).map(t => ({ text: t, size: 11 })));
 }
 if (spec.footer) lines.push({ text: '', size: 10, gap: 10 }, ...wrap(spec.footer, 95).map(t => ({ text: t, size: 9 })));
 const pages: string[] = []; let y = 790, buf: string[] = [];
 const flush = () => { pages.push(buf.join('\n')); buf = []; y = 790; };
 for (const l of lines) {
  const h = l.size * 1.35 + (l.gap ?? 0);
  if (y - h < 50) flush();
  y -= h;
  if (l.text) buf.push(`BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf 50 ${y.toFixed(1)} Td (${esc(l.text)}) Tj ET`);
 }
 flush();
 const objs: string[] = [];
 const pageIds = pages.map((_, i) => 5 + i * 2);
 objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
 objs[2] = `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pages.length} >>`;
 objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
 objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
 pages.forEach((content, i) => {
  objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
  objs[6 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
 });
 const infoId = objs.length;
 objs[infoId] = `<< /Title (${esc(spec.title)}) /Producer (White-label UAT) /CreationDate (D:${spec.created.replace(/[-:T]/g, '').slice(0, 8)}000000Z) >>`;
 let out = '%PDF-1.4\n'; const offsets: number[] = [];
 for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
 const xref = out.length;
 out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
 out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return new TextEncoder().encode(out);
}

export const PDF_LIMITS = { bytes: 2 * 1024 * 1024, pages: 50 };
export const PDF_COMPLEXITY = { objects: 25000, nodes: 100000 };
const BLOCKED_KEYS = new Set(['JavaScript', 'JS', 'AA', 'EmbeddedFile', 'EmbeddedFiles', 'EF', 'AF', 'RichMedia', 'RichMediaContent', 'XFA']);
const BLOCKED_TYPES = new Set(['EmbeddedFile', 'FileAttachment', 'RichMedia', 'Movie', 'Sound', 'Screen', '3D']);
const NAMED_NAVIGATION = new Set(['FirstPage', 'LastPage', 'NextPage', 'PrevPage', 'GoBack', 'GoForward']);
export class PdfError extends Error {}

// Parses objects, not page text, and never executes actions or rewrites the uploaded bytes. Not a malware scan.
export async function validateUploadedPdf(bytes: Uint8Array): Promise<{ pages: number; warnings: string[] }> {
 if (bytes.length > PDF_LIMITS.bytes) throw new PdfError(`PDF is larger than ${PDF_LIMITS.bytes / 1024 / 1024} MiB`);
 const decoder = new TextDecoder('latin1');
 if (!/^%PDF-(?:1\.[0-7]|2\.0)/.test(decoder.decode(bytes.subarray(0, 16)))) throw new PdfError('File is not a PDF (missing PDF header)');
 if (!decoder.decode(bytes.subarray(-1100)).includes('%%EOF')) throw new PdfError('PDF is truncated (no %%EOF marker)');
 try {
  const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  if (document.isEncrypted) throw new PdfError('Encrypted PDFs cannot be screened. Upload an unencrypted copy.');
  return screenPdf(document);
 } catch (e) {
  if (e instanceof PdfError) throw e;
  if (e instanceof Error && e.name === 'EncryptedPDFError') throw new PdfError('Encrypted PDFs cannot be screened. Upload an unencrypted copy.');
  throw new PdfError('PDF could not be parsed for structural screening. Export a valid, unencrypted PDF with links preserved and try again.');
 }
}

function screenPdf(document: PDFDocument): { pages: number; warnings: string[] } {
 const context = document.context;
 const objects = context.enumerateIndirectObjects();
 if (objects.length > PDF_COMPLEXITY.objects) throw new PdfError('PDF is too complex to screen (more than 25,000 objects). Split it into smaller documents with links preserved.');
 let work = 0;
 const spend = () => {
  if (++work > PDF_COMPLEXITY.nodes) throw new PdfError('PDF is too complex to screen (more than 100,000 object visits). Split it into smaller documents with links preserved.');
 };
 const resolve = (value: PDFObject | undefined): PDFObject | undefined => {
  if (!(value instanceof PDFRef)) return value;
  const resolved = context.lookup(value);
  if (!resolved || resolved instanceof PDFRef) throw new PdfError('PDF contains an unresolved object reference.');
  return resolved;
 };
 const name = (value: PDFObject | undefined) => {
  const object = resolve(value);
  return object instanceof PDFName ? object.decodeText() : '';
 };
 const text = (value: PDFObject | undefined) => {
  const object = resolve(value);
  return object instanceof PDFString || object instanceof PDFHexString ? object.decodeText() : '';
 };
 const get = (dict: PDFDict, key: string) => dict.get(PDFName.of(key));
 const destination = (value: PDFObject | undefined) => {
  const object = resolve(value);
  if (object instanceof PDFName && object.decodeText()) return;
  if ((object instanceof PDFString || object instanceof PDFHexString) && object.decodeText()) return;
  if (object instanceof PDFArray && object.size() >= 2) {
   const page = resolve(object.get(0));
   if ((page instanceof PDFDict && name(get(page, 'Type')) === 'Page') || (page instanceof PDFNumber && Number.isInteger(page.asNumber()) && page.asNumber() >= 0)) return;
  }
  throw new PdfError('PDF contains an invalid internal navigation destination.');
 };
 let hasLinks = false, hasForms = false;
 const checkedActions = new Set<PDFObject>(), checkedOpeningActions = new Set<PDFObject>();
 const action = (value: PDFObject | undefined, opening = false) => {
  const pending = [value];
  const checked = opening ? checkedOpeningActions : checkedActions;
  while (pending.length) {
   spend();
   const object = resolve(pending.pop());
   if (object && checked.has(object)) continue;
   if (object instanceof PDFArray) {
    checked.add(object);
    for (let i = 0; i < object.size(); i++) pending.push(object.get(i));
    continue;
   }
   if (!(object instanceof PDFDict)) throw new PdfError('PDF contains an invalid navigation action.');
   checked.add(object);
   const type = name(get(object, 'S'));
   if (type === 'GoTo') destination(get(object, 'D'));
   else if (type === 'URI' && !opening) {
    const uri = text(get(object, 'URI'));
    let url: URL;
    try { url = new URL(uri); } catch { throw new PdfError('PDF contains an invalid web or email link. Only absolute HTTP, HTTPS and mailto links are supported.'); }
    if (/[\u0000-\u0020\u007f]/.test(uri) || !(
     ((url.protocol === 'https:' || url.protocol === 'http:') && /^https?:\/\//i.test(uri) && url.hostname) ||
     (url.protocol === 'mailto:' && url.pathname)
    )) throw new PdfError('PDF contains an unsafe or unsupported link scheme. HTTP, HTTPS and mailto links are allowed.');
    hasLinks = true;
   } else if (type === 'Named' && !opening && NAMED_NAVIGATION.has(name(get(object, 'N')))) {
    // Built-in page/history navigation has no external side effects.
   } else throw new PdfError(`PDF contains a disallowed ${opening ? 'opening ' : ''}action /${type || 'unknown'}. Internal navigation and ordinary web/email links are allowed; executable and automatic external actions are not.`);
   const next = get(object, 'Next');
   if (next) pending.push(next);
  }
 };
 const seen = new Set<PDFObject>();
 const pending: PDFObject[] = objects.map(([, object]) => object);
 while (pending.length) {
  spend();
  const object = resolve(pending.pop());
  if (!object || seen.has(object)) continue;
  seen.add(object);
  if (object instanceof PDFInvalidObject) throw new PdfError('PDF contains a malformed object and cannot be screened.');
  if (object instanceof PDFArray) {
   for (let i = 0; i < object.size(); i++) pending.push(object.get(i));
   continue;
  }
  const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
  if (!dict) continue;
  const type = name(get(dict, 'Type')), subtype = name(get(dict, 'Subtype'));
  if (BLOCKED_TYPES.has(type) || BLOCKED_TYPES.has(subtype)) throw new PdfError(`PDF contains /${BLOCKED_TYPES.has(type) ? type : subtype}, which is not supported (embedded files or active media).`);
  if (type === 'Action') action(dict);
  const opening = get(dict, 'OpenAction');
  if (opening) {
   const target = resolve(opening);
   if (target instanceof PDFDict) action(target, true); else destination(target);
  }
  // /A also means structural attributes in tagged PDFs, so only interpret it as an action on action-bearing objects.
  const owner = type === 'Annot' || !!subtype || dict.has(PDFName.of('Title')) || dict.has(PDFName.of('FT'));
  if (owner && get(dict, 'A')) action(get(dict, 'A'));
  if (owner && get(dict, 'Dest')) destination(get(dict, 'Dest'));
  for (const [key, value] of dict.entries()) {
   const decoded = key.decodeText();
   if (BLOCKED_KEYS.has(decoded)) throw new PdfError(`PDF contains /${decoded}, which is not supported (scripts, automatic actions or embedded content). Ordinary links are allowed.`);
   if (decoded === 'AcroForm') hasForms = true;
   pending.push(value);
  }
 }
 let pages = 0;
 const pageNodes = [get(document.catalog, 'Pages')];
 const seenPages = new Set<PDFObject>();
 while (pageNodes.length) {
  spend();
  const node = resolve(pageNodes.pop());
  if (!(node instanceof PDFDict) || seenPages.has(node)) throw new PdfError('PDF contains an invalid or cyclic page tree.');
  seenPages.add(node);
  const type = name(get(node, 'Type'));
  if (type === 'Page') {
   if (++pages > PDF_LIMITS.pages) throw new PdfError(`PDF has more than ${PDF_LIMITS.pages} pages`);
  } else if (type === 'Pages') {
   const children = resolve(get(node, 'Kids'));
   if (!(children instanceof PDFArray)) throw new PdfError('PDF contains an invalid page tree.');
   for (let i = 0; i < children.size(); i++) pageNodes.push(children.get(i));
  } else throw new PdfError('PDF contains an invalid page tree.');
 }
 if (!pages) throw new PdfError('PDF has no readable pages');
 return { pages, warnings: [
  ...(hasLinks ? ['External links are preserved. Their destinations have not been verified.'] : []),
  ...(hasForms ? ['This PDF contains form fields. Form behavior depends on the viewer; no scripts are permitted.'] : [])
 ] };
}
export const safeFilename = (name: string) => name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'document.pdf';
