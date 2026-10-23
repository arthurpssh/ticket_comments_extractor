const ExcelJS = require('exceljs');
const { limits } = require('../config/extraction');

const TRUNCATE_NOTE = '\n[TRUNCADO: limite de caracteres da célula]';

function fitCell(text) {
  if (text.length <= limits.maxCellChars) return text;
  return text.slice(0, limits.maxCellChars - TRUNCATE_NOTE.length) + TRUNCATE_NOTE;
}

/**
 * Gera o .xlsx (Buffer) com as colunas ticket_id e comments_concat.
 * @param {{ ticket_id: string, comments_concat: string }[]} rows
 */
async function buildXlsx(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('comentarios');

  sheet.columns = [
    { header: 'ticket_id', key: 'ticket_id', width: 14 },
    { header: 'comments_concat', key: 'comments_concat', width: 120 },
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { horizontal: 'center' };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  rows.forEach((row) => {
    // ticket_id como texto (igual ao arquivo gerado pelo Apps Script)
    sheet.addRow({ ticket_id: String(row.ticket_id), comments_concat: fitCell(row.comments_concat) });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildXlsx };
