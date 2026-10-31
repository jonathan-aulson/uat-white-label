import type { Env, Identity } from './types';
export class HttpError extends Error {
 constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
export const json = (value: unknown, status = 200) => Response.json(value, { status });
export const now = () => new Date().toISOString();
type Arg = string | number | null | ArrayBuffer;
export const statement = (env: Env, sql: string, ...args: Arg[]) => env.DB.prepare(sql).bind(...args);
export async function all<T>(env: Env, sql: string, ...args: Arg[]): Promise<T[]> {
 return (await statement(env, sql, ...args).all<T>()).results;
}
export const first = <T>(env: Env, sql: string, ...args: Arg[]) => statement(env, sql, ...args).first<T>();
export const audit = (env: Env, user: Pick<Identity, 'sub'>, action: string, target: string, detail = '') =>
 statement(env, 'INSERT INTO audit(ts,actor_sub,action,target,detail) VALUES(?,?,?,?,?)', now(), user.sub, action, target, detail);
export async function limitedBytes(request: Request, maxBytes = 16384): Promise<Uint8Array> {
 if (Number(request.headers.get('content-length')) > maxBytes) throw new HttpError(413, `Body exceeds ${maxBytes} bytes`);
 const reader = request.body?.getReader();
 let size = 0; const chunks: Uint8Array[] = [];
 if (reader) while (true) {
  const { done, value } = await reader.read(); if (done) break;
  size += value.byteLength;
  if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, `Body exceeds ${maxBytes} bytes`); }
  chunks.push(value);
 }
 const bytes = new Uint8Array(size); let offset = 0;
 for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
 return bytes;
}
export async function body(request: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
 try {
  const parsed = JSON.parse(new TextDecoder().decode(await limitedBytes(request, maxBytes)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
  return parsed;
 } catch (e) {
  if (e instanceof HttpError) throw e;
  throw new HttpError(400, 'Invalid JSON object');
 }
}
export function text(value: unknown, max: number, required = false): string {
 if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `Text must be ${required ? 'non-empty and ' : ''}at most ${max} characters`);
 return value;
}
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
 const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
 const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
 return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const uuid = () => crypto.randomUUID();
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const record = (...a: Parameters<typeof audit>) => audit(...a).run();
