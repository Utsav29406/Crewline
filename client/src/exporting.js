/** Report downloads: Excel (.xlsx, library loaded only when used) and PDF (the browser's print-to-PDF). */

/** `head`: column titles; `rows`: arrays of values (numbers stay numbers in Excel). */
export async function downloadExcel(fileName, head, rows, { sheet = 'Report', widths } = {}) {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const data = [
    head.map((h) => ({ value: h, fontWeight: 'bold', backgroundColor: '#E8EBF2' })),
    ...rows.map((r) => r.map((v) => (v === undefined || v === '' ? null : v))),
  ];
  const columns = head.map((h, i) => ({ width: widths?.[i] ?? Math.min(Math.max(String(h).length + 2, 10), 40) }));
  await writeExcelFile(data, { columns, sheet, stickyRowsCount: 1 }).toFile(fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
}

/** Prints just the report on the page; choose "Save as PDF" in the print dialog. */
export function printReport() {
  document.body.classList.add('print-report');
  const done = () => {
    document.body.classList.remove('print-report');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}
