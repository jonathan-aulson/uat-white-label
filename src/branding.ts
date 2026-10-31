import type { Workspace } from './types';

export const FONT_STACKS = {
 system: { ui: 'system-ui,-apple-system,"Segoe UI",Arial,sans-serif', body: 'system-ui,-apple-system,"Segoe UI",Arial,sans-serif', faces: '' },
 roboto: { ui: 'Roboto,Arial,sans-serif', body: 'Roboto,Arial,sans-serif', faces: '@font-face{font-family:Roboto;src:url(/fonts/roboto.ttf) format("truetype");font-weight:100 900;font-display:swap}' },
 'roboto-baskerville': { ui: 'Roboto,Arial,sans-serif', body: '"Libre Baskerville",Georgia,serif', faces: '@font-face{font-family:Roboto;src:url(/fonts/roboto.ttf) format("truetype");font-weight:100 900;font-display:swap}@font-face{font-family:"Libre Baskerville";src:url(/fonts/libre-baskerville.ttf) format("truetype");font-weight:400 700;font-display:swap}' }
} as const;

export type RGB = [number, number, number];
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const parseHex = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB;
export const toHex = (c: RGB) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a: string, b: string): number {
 const x = luminance(parseHex(a)), y = luminance(parseHex(b));
 return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const mix = (a: string, b: string, t: number): string => { const x = parseHex(a), y = parseHex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t) as RGB); };
export const onColor = (bg: string) => contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111';

// Move `color` away from `bg` (toward the better extreme) until it reaches `min` contrast.
export function suggestContrast(color: string, bg: string, min: number): string | null {
 const dir = luminance(parseHex(bg)) > 0.4 ? '#000000' : '#ffffff';
 for (let t = 0; t <= 1.0001; t += 0.02) { const c = mix(color, dir, t); if (contrast(c, bg) >= min) return c; }
 return null;
}

export interface BrandCheck { ok: boolean; errors: { field: string; message: string; suggestion?: string }[]; ratios: Record<string, number> }
export function checkBranding(b: { primary: string; accent: string; background: string }): BrandCheck {
 const errors: BrandCheck['errors'] = []; const ratios: Record<string, number> = {};
 for (const f of ['primary', 'accent', 'background'] as const) if (!HEX_RE.test(b[f])) errors.push({ field: f, message: `${f} must be a 6-digit hex colour such as #0b4751` });
 if (errors.length) return { ok: false, errors, ratios };
 ratios.primaryOnBackground = contrast(b.primary, b.background);
 ratios.accentOnBackground = contrast(b.accent, b.background);
 ratios.textOnPrimary = contrast(b.primary, onColor(b.primary));
 if (ratios.primaryOnBackground < 4.5) errors.push({ field: 'primary', message: `Primary colour is used for links and headings on the background; contrast is ${ratios.primaryOnBackground.toFixed(2)}:1 but 4.5:1 is required.`, suggestion: suggestContrast(b.primary, b.background, 4.5) ?? undefined });
 if (ratios.accentOnBackground < 3) errors.push({ field: 'accent', message: `Accent colour is used for focus rings and selection markers; contrast is ${ratios.accentOnBackground.toFixed(2)}:1 but 3:1 is required.`, suggestion: suggestContrast(b.accent, b.background, 3) ?? undefined });
 return { ok: errors.length === 0, errors, ratios };
}

export function deriveTheme(w: Pick<Workspace, 'primary' | 'accent' | 'background' | 'font'>) {
 const bg = w.background.toLowerCase();
 const dark = luminance(parseHex(bg)) < 0.4;
 const ink = dark ? '#f5f5f5' : '#111111';
 const surface = dark ? mix(bg, '#ffffff', 0.06) : mix(bg, '#ffffff', 0.7);
 let muted = mix(ink, bg, 0.3); if (contrast(muted, bg) < 4.5 || contrast(muted, surface) < 4.5) muted = ink;
 let control = mix(bg, ink, 0.55); for (let t = 0.55; contrast(control, surface) < 3 && t < 1; t += 0.05) control = mix(bg, ink, t);
 let hover = mix(w.primary, dark ? '#ffffff' : '#000000', 0.18);
 if (contrast(hover, onColor(w.primary)) < 4.5) hover = w.primary;
 return {
  primary: w.primary.toLowerCase(), onPrimary: onColor(w.primary), primaryHover: hover, onPrimaryHover: onColor(hover),
  accent: w.accent.toLowerCase(), bg, surface, ink, muted, line: mix(bg, ink, 0.2), control,
  tint: mix(surface, w.primary, 0.08)
 };
}
export function themeCss(w: Pick<Workspace, 'primary' | 'accent' | 'background' | 'font'>, revision: number): string {
 const t = deriveTheme(w); const f = FONT_STACKS[w.font] ?? FONT_STACKS.system;
 return `/* branding revision ${revision} */\n${f.faces}\n:root{--primary:${t.primary};--on-primary:${t.onPrimary};--primary-hover:${t.primaryHover};--on-primary-hover:${t.onPrimaryHover};--accent:${t.accent};--bg:${t.bg};--surface:${t.surface};--ink:${t.ink};--muted:${t.muted};--line:${t.line};--control:${t.control};--tint:${t.tint};--ui:${f.ui};--body:${f.body}}\n`;
}

// ---- Image sanitising: lossless, no resampling. Strips metadata, keeps pixel data byte-identical. ----
export interface CleanImage { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array; width: number; height: number }
export class ImageError extends Error {}
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const IMAGE_LIMITS = { bytes: 300 * 1024, side: 4096 };
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM']);

export function sanitizeImage(input: Uint8Array): CleanImage {
 if (input.length > IMAGE_LIMITS.bytes) throw new ImageError(`Image is larger than ${IMAGE_LIMITS.bytes / 1024} KiB`);
 if (input.length > 8 && input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47) return sanitizePng(input);
 if (input.length > 4 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return sanitizeJpeg(input);
 throw new ImageError('Only PNG and JPEG images are accepted (SVG and other formats are not allowed)');
}
function checkSize(w: number, h: number) {
 if (!w || !h || w > IMAGE_LIMITS.side || h > IMAGE_LIMITS.side) throw new ImageError(`Image dimensions must be between 1 and ${IMAGE_LIMITS.side} px`);
}
function sanitizePng(b: Uint8Array): CleanImage {
 const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
 if (sig.some((v, i) => b[i] !== v)) throw new ImageError('Corrupt PNG signature');
 const parts: Uint8Array[] = [b.slice(0, 8)]; let o = 8, width = 0, height = 0, sawIdat = false, sawEnd = false, first = true;
 while (o + 12 <= b.length && !sawEnd) {
  const len = u32(b, o); const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
  if (o + 12 + len > b.length) throw new ImageError('Truncated PNG');
  if (first && type !== 'IHDR') throw new ImageError('PNG must begin with IHDR');
  if (type === 'IHDR') { if (len !== 13) throw new ImageError('Bad IHDR'); width = u32(b, o + 8); height = u32(b, o + 12); }
  if (type === 'IDAT') sawIdat = true;
  if (type === 'IEND') sawEnd = true;
  if (PNG_KEEP.has(type)) parts.push(b.slice(o, o + 12 + len));
  first = false; o += 12 + len;
 }
 if (!sawIdat || !sawEnd) throw new ImageError('PNG has no image data or is truncated');
 checkSize(width, height);
 return { mime: 'image/png', bytes: concat(parts), width, height };
}
function sanitizeJpeg(b: Uint8Array): CleanImage {
 const parts: Uint8Array[] = [b.slice(0, 2)]; let o = 2, width = 0, height = 0, sos = false;
 while (o + 4 <= b.length) {
  if (b[o] !== 0xff) throw new ImageError('Corrupt JPEG');
  const marker = b[o + 1];
  if (marker === 0xff) { o++; continue; }
  const len = (b[o + 2] << 8) | b[o + 3];
  if (len < 2 || o + 2 + len > b.length) throw new ImageError('Truncated JPEG');
  if (marker === 0xe1 && String.fromCharCode(...b.slice(o + 4, o + 8)) === 'Exif') {
   // Orientation tag != 1 would rotate the image in browsers; stripping EXIF would silently change appearance.
   const tiff = o + 10, le = b[tiff] === 0x49;
   const rd16 = (p: number) => le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1];
   const rd32 = (p: number) => le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : u32(b, p);
   const ifd = tiff + rd32(tiff + 4);
   if (ifd + 2 < b.length) for (let i = 0, n = rd16(ifd); i < n && ifd + 2 + i * 12 + 12 <= b.length; i++) {
    const e = ifd + 2 + i * 12;
    if (rd16(e) === 0x0112 && rd16(e + 8) !== 1) throw new ImageError('JPEG has an EXIF rotation. Re-save it upright (without rotation metadata) and upload again.');
   }
  }
  const isApp = marker >= 0xe0 && marker <= 0xef, isCom = marker === 0xfe;
  if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { height = (b[o + 5] << 8) | b[o + 6]; width = (b[o + 7] << 8) | b[o + 8]; }
  if (!isApp && !isCom) parts.push(b.slice(o, o + 2 + len));
  o += 2 + len;
  if (marker === 0xda) { sos = true; break; }
 }
 if (!sos || !width) throw new ImageError('JPEG has no image data');
 checkSize(width, height);
 if (!(b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9)) throw new ImageError('JPEG is truncated');
 parts.push(b.slice(o));
 return { mime: 'image/jpeg', bytes: concat(parts), width, height };
}
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
