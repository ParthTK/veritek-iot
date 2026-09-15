/**
 * Client-side CSV export. Everything here runs in the browser — the "export"
 * actions in this demo are genuine downloads of the mock data, not stubs.
 */

type Cell = string | number | null | undefined;

function escapeCell(value: Cell): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join(
    '\n',
  );
}

export function downloadCsv(filename: string, headers: string[], rows: Cell[][]): void {
  // BOM keeps Excel from mangling the ₹ sign and other non-ASCII characters.
  const blob = new Blob(['﻿', toCsv(headers, rows)], {
    type: 'text/csv;charset=utf-8;',
  });
  triggerDownload(blob, filename);
}

/**
 * Stand-in for server-side PDF generation: emits a printable HTML document so
 * the button does something real. A backend would return a true PDF here.
 */
export function downloadPdfStub(filename: string, title: string, html: string): void {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828;margin:32px}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#667085;font-size:12px;margin-bottom:20px}
 table{border-collapse:collapse;width:100%;font-size:11px}
 th,td{border:1px solid #E4E7EC;padding:5px 7px;text-align:left}
 th{background:#F9FAFB;font-weight:600}
</style></head><body>${html}</body></html>`;
  triggerDownload(new Blob([doc], { type: 'text/html;charset=utf-8;' }), filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
