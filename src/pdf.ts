// Minimal deterministic PDF writer (Helvetica, text only) and an upload gate for reviewed PDFs.
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
const ACTIVE = ['JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'SubmitForm', 'ImportData', 'URI', 'GoToR', 'GoToE', 'Encrypt', 'AcroForm', 'Movie', 'Sound', 'ObjStm'];
export class PdfError extends Error {}
// Structural screening only. It cannot detect everything (e.g. active content inside compressed streams) and is not a malware scan.
export function validateUploadedPdf(bytes: Uint8Array): { pages: number } {
 if (bytes.length > PDF_LIMITS.bytes) throw new PdfError(`PDF is larger than ${PDF_LIMITS.bytes / 1024 / 1024} MiB`);
 const latin = new TextDecoder('latin1').decode(bytes);
 if (!/^%PDF-1\.[0-7]/.test(latin)) throw new PdfError('File is not a PDF (missing %PDF-1.x header)');
 if (!latin.slice(-1100).includes('%%EOF')) throw new PdfError('PDF is truncated (no %%EOF marker)');
 // Names may hide letters with #xx escapes; decode before matching.
 const decoded = latin.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
 for (const word of ACTIVE) if (new RegExp(`/${word}(?![A-Za-z0-9])`).test(decoded)) throw new PdfError(word === 'ObjStm' ? 'PDF uses compressed object streams, which cannot be screened. Re-save it as a plain PDF (for example PDF 1.4 compatibility / "Print to PDF") and upload again.' : `PDF contains /${word}, which is not allowed (active, encrypted or embedded content)`);
 const pages = (decoded.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
 if (!pages) throw new PdfError('PDF has no readable pages');
 if (pages > PDF_LIMITS.pages) throw new PdfError(`PDF has more than ${PDF_LIMITS.pages} pages`);
 return { pages };
}
export const safeFilename = (name: string) => name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'document.pdf';
