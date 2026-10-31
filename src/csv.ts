export function csv(rows: Record<string, unknown>[], columns = rows.length ? Object.keys(rows[0]) : ['empty']) {
 const cell = (value: unknown) => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
 };
 return [columns.map(cell).join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\r\n');
}
