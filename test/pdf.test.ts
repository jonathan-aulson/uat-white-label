import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { generatePdf, PDF_COMPLEXITY, PDF_LIMITS, validateUploadedPdf } from '../src/pdf';
import { ADMIN, ok, request, setupApp } from './helpers';
import { pdfFixture, pdfLink } from './pdf-fixtures';

beforeAll(setupApp);

it('parses both ordinary and compressed PDFs in the Workers runtime', async () => {
 const plain = generatePdf({ title: 'PDF parser smoke', rows: [], created: '2026-10-31' });
 const document = await PDFDocument.load(plain, { updateMetadata: false });
 expect(document.getPageCount()).toBe(1);
 const compressed = await document.save({ useObjectStreams: true });
 expect((await PDFDocument.load(compressed, { updateMetadata: false })).getPageCount()).toBe(1);
});

it.each([false, true])('preserves links, internal destinations and harmless opening actions (compressed=%s)', async compressed => {
 const bytes = await pdfFixture(document => {
  const context = document.context;
  for (const uri of ['https://allata.com/', 'http://example.com/', 'mailto:team@example.com']) {
   pdfLink(document, context.obj({ S: 'URI', URI: PDFString.of(uri) }));
  }
  pdfLink(document, context.obj({ S: 'URI', URI: PDFHexString.fromText('https://example.com/?a=1&b=2') }));
  pdfLink(document, context.obj({ S: 'GoTo', D: [document.getPage(0).ref, 'Fit'] }));
  pdfLink(document, context.obj({ S: 'Named', N: 'NextPage' }));
  document.catalog.set(PDFName.of('OpenAction'), context.register(context.obj({ S: 'GoTo', D: [document.getPage(0).ref, 'Fit'] })));
 }, compressed);
 const original = bytes.slice();
 const info = await validateUploadedPdf(bytes);
 expect(info.pages).toBe(1);
 expect(info.warnings).toContain('External links are preserved. Their destinations have not been verified.');
 expect(bytes).toEqual(original);
});

it('accepts explicit and named opening destinations, text mentioning blocked words and ordinary tagged attributes', async () => {
 for (const kind of ['array', 'name', 'string']) {
  const bytes = await pdfFixture(document => {
   const context = document.context, destination = context.obj([document.getPage(0).ref, 'Fit']);
   document.catalog.set(PDFName.of('Names'), context.obj({ Dests: { Names: [PDFString.of('JavaScript'), destination] } }));
   document.catalog.set(PDFName.of('OpenAction'), kind === 'array' ? destination : kind === 'name' ? PDFName.of('JavaScript') : PDFString.of('JavaScript'));
   document.setTitle('This paper discusses /JavaScript, /URI and /OpenAction.');
   document.getPage(0).drawText('Example PDF text: /JavaScript /URI /OpenAction');
   document.catalog.set(PDFName.of('StructTreeRoot'), context.obj({
    Type: 'StructTreeRoot', K: [{ Type: 'StructElem', S: 'P', A: { O: 'Layout', TextAlign: 'Start' } }]
   }));
  });
  expect((await validateUploadedPdf(bytes)).pages).toBe(1);
 }
});

it('allows ordinary form fields with a warning', async () => {
 const bytes = await pdfFixture(document => {
  document.getForm().createTextField('Synthetic note').addToPage(document.getPage(0));
 });
 expect((await validateUploadedPdf(bytes)).warnings.join(' ')).toContain('form fields');
});

it.each(['JavaScript', 'Launch', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData', 'Rendition', 'UnknownAction'])('rejects disallowed or unknown action subtype %s', async type => {
 const bytes = await pdfFixture(document => pdfLink(document, document.context.obj({ S: type })));
 await expect(validateUploadedPdf(bytes)).rejects.toThrow(new RegExp(type));
});

it.each(['javascript:alert(1)', 'file:///tmp/test.pdf', 'data:text/html,test', 'ftp://example.com/', '/relative', 'https://', 'mailto:', 'https://example.com/\nother'])('rejects unsafe or invalid URI %s', async uri => {
 const bytes = await pdfFixture(document => pdfLink(document, document.context.obj({ S: 'URI', URI: PDFString.of(uri) })));
 await expect(validateUploadedPdf(bytes)).rejects.toThrow(/link|scheme/);
});

it('detects escaped names, hex/escaped unsafe links and chained actions inside compressed objects', async () => {
 for (const make of [
  (document: PDFDocument) => document.context.obj({ S: PDFName.of('J#61vaScript'), JS: PDFString.of('alert(1)') }),
  (document: PDFDocument) => document.context.obj({ S: 'URI', URI: PDFHexString.fromText('javascript:alert(1)') }),
  (document: PDFDocument) => {
   const action = document.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/') });
   action.set(PDFName.of('Next'), document.context.register(document.context.obj({ S: 'Launch' })));
   return action;
  }
 ]) {
  const bytes = await pdfFixture(document => pdfLink(document, make(document)));
  await expect(validateUploadedPdf(bytes)).rejects.toThrow(/JavaScript|scheme|Launch/);
 }
});

it('rejects external opening actions and chained external actions on opening', async () => {
 for (const chained of [false, true]) {
  const bytes = await pdfFixture(document => {
   const external = document.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/') });
   const opening = chained ? document.context.obj({ S: 'GoTo', D: [document.getPage(0).ref, 'Fit'], Next: external }) : external;
   document.catalog.set(PDFName.of('OpenAction'), document.context.register(opening));
  });
  await expect(validateUploadedPdf(bytes)).rejects.toThrow(/opening action.*URI/);
 }
});

it('rejects attachments, automatic actions, active media, XFA and encryption', async () => {
 for (const build of [
  async (document: PDFDocument) => { await document.attach(new Uint8Array([1, 2, 3]), 'embedded.txt'); },
  (document: PDFDocument) => { document.catalog.set(PDFName.of('AA'), document.context.obj({})); },
  (document: PDFDocument) => { document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ XFA: PDFString.of('dynamic form') })); },
  (document: PDFDocument) => { document.context.register(document.context.obj({ Type: 'Annot', Subtype: 'RichMedia' })); },
  (document: PDFDocument) => { document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({ Filter: 'Standard' })); }
 ]) {
  const bytes = await pdfFixture(build);
  await expect(validateUploadedPdf(bytes)).rejects.toThrow(/embedded|automatic|XFA|RichMedia|Encrypted/i);
 }
});

it('rejects malformed, oversized and over-page-limit documents', async () => {
 const encode = (s: string) => new TextEncoder().encode(s);
 await expect(validateUploadedPdf(encode('%PDF-1.7\n1 0 obj\nbroken\n%%EOF'))).rejects.toThrow(/parsed/);
 await expect(validateUploadedPdf(encode('%PDF-1.7\ntruncated'))).rejects.toThrow(/truncated/);
 await expect(validateUploadedPdf(new Uint8Array(PDF_LIMITS.bytes + 1))).rejects.toThrow(/larger/);
 await expect(validateUploadedPdf(await pdfFixture(undefined, true, PDF_LIMITS.pages + 1))).rejects.toThrow(/50 pages/);
 const cyclic = encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
 await expect(validateUploadedPdf(cyclic)).rejects.toThrow(/cyclic page tree/);
});

it('decodes escaped action names and literal strings rather than screening raw keywords', async () => {
 const plain = await pdfFixture(document => pdfLink(document, document.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/') })), false);
 const text = new TextDecoder('latin1').decode(plain);
 const escapedAllowed = text.replace('/S /URI', '/S /U#52I').replace('(https://example.com/)', '(https://example.com/\\160age)');
 expect((await validateUploadedPdf(new TextEncoder().encode(escapedAllowed))).pages).toBe(1);
 const escapedUnsafe = text.replace('/S /URI', '/S /U#52I').replace('(https://example.com/)', '(java\\163cript:alert\\(1\\))');
 await expect(validateUploadedPdf(new TextEncoder().encode(escapedUnsafe))).rejects.toThrow(/scheme/);
 const escapedScript = text.replace('/S /URI', '/S /J#61vaScript');
 await expect(validateUploadedPdf(new TextEncoder().encode(escapedScript))).rejects.toThrow(/JavaScript/);
});

it('screens 1,000 web links within a bounded Workers budget', async () => {
 const bytes = await pdfFixture(document => {
  for (let i = 0; i < 1000; i++) pdfLink(document, document.context.obj({ S: 'URI', URI: PDFString.of(`https://example.com/page/${i}`) }));
 });
 expect(bytes.length).toBeLessThan(PDF_LIMITS.bytes);
 const start = performance.now();
 expect((await validateUploadedPdf(bytes)).pages).toBe(1);
 expect(performance.now() - start).toBeLessThan(5000);
}, 10000);

it('rejects excessive object graphs and handles cyclic navigation arrays without hanging', async () => {
 const large = await pdfFixture(document => {
  for (let i = 0; i < PDF_COMPLEXITY.objects; i++) document.context.register(document.context.obj({ Value: i }));
 });
 await expect(validateUploadedPdf(large)).rejects.toThrow(/too complex/);
 const cyclic = await pdfFixture(document => {
  const action = document.context.obj({ S: 'GoTo', D: [document.getPage(0).ref, 'Fit'] });
  const next = document.context.obj([]);
  const ref = document.context.register(next);
  next.push(ref);
  action.set(PDFName.of('Next'), ref);
  pdfLink(document, action);
 });
 expect((await validateUploadedPdf(cyclic)).pages).toBe(1);
}, 10000);

it('stores and downloads linked PDF bytes unchanged, with the original SHA-256', async () => {
 const bytes = await pdfFixture(document => {
  pdfLink(document, document.context.obj({ S: 'URI', URI: PDFString.of('https://allata.com/') }));
 });
 const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
 const uploaded = await ok<{ id: string; sha256: string; warnings: string[] }>(request('/api/admin/documents?title=Linked%20PDF&attested=1', 'POST', undefined, ADMIN, {}, { body: bytes, type: 'application/pdf' }), 201);
 expect(uploaded.sha256).toBe(sha);
 expect(uploaded.warnings.join(' ')).toContain('External links are preserved');
 const downloaded = await request(`/api/admin/documents/${uploaded.id}/download`);
 expect(downloaded.headers.get('content-disposition')).toContain('attachment;');
 expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
 const row = await env.DB.prepare('SELECT r2_key FROM documents WHERE id=?').bind(uploaded.id).first<{ r2_key: string }>();
 const stored = await env.DOCS!.get(row!.r2_key);
 expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
 const unsafe = await pdfFixture(document => pdfLink(document, document.context.obj({ S: 'Launch' })));
 const rejected = await request('/api/admin/documents?title=Unsafe&attested=1', 'POST', undefined, ADMIN, {}, { body: unsafe, type: 'application/pdf' });
 expect(rejected.status).toBe(400);
 expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('Launch') });
});
