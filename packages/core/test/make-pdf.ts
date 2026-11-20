/** テスト用の PDF を作る（単体テストと E2E で共用） */
/** 1 ページに 1 行ずつ文字を置いた最小の PDF（Helvetica） */
export function makePdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines, i) => {
    const esc = (t: string) => t.replace(/[\\()]/g, m => `\\${m}`);
    const body = lines.map((l, j) => `BT /F1 12 Tf 72 ${720 - j * 20} Td (${esc(l)}) Tj ET`).join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

