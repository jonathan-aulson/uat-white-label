import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';

export async function pdfFixture(configure?: (document: PDFDocument) => void | Promise<void>, compressed = true, pages = 1) {
 const document = await PDFDocument.create();
 for (let i = 0; i < pages; i++) document.addPage();
 await configure?.(document);
 return document.save({ useObjectStreams: compressed });
}

export function pdfLink(document: PDFDocument, action: PDFDict) {
 const page = document.getPage(0);
 const annotation = document.context.register(document.context.obj({
  Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 100, 30], A: document.context.register(action)
 }));
 const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray) ?? document.context.obj([]);
 annotations.push(annotation);
 page.node.set(PDFName.of('Annots'), annotations);
}
