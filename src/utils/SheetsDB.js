const { getSheetsClient } = require('../config/googleClient');

/**
 * Abstração de "banco" sobre o Google Sheets (derivada do SheetsDB do template Magic Deploy).
 *
 * Diferenças em relação ao template, para manter o comportamento do DBMethods do Apps Script:
 *  - Lê com UNFORMATTED_VALUE: números continuam números (ex.: IDs do Zendesk) e células vazias viram "".
 *  - Grava com RAW: textos nunca são reinterpretados pelo Sheets (HTML começando com "=" ou "+"
 *    não vira fórmula, "1/2" não vira data).
 *  - patchRows altera só as células informadas, em vez de regravar a linha inteira.
 *  - Sem limite de colunas (não usa A:Z) e nomes de aba são sempre citados em A1 notation.
 */

// 'Base de Macros' -> "'Base de Macros'" (apóstrofos escapados dobrando)
const quoteSheet = (sheetName) => `'${String(sheetName).replace(/'/g, "''")}'`;

// 0 -> A, 25 -> Z, 26 -> AA
function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Mesmo contrato do sanitizeValue_ do DBMethods: objetos viram JSON, null/undefined viram ""
function sanitizeValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'boolean' || typeof val === 'number') return val;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

class SheetsDB {
  /**
   * Engine de queries (portado do GAS evaluateMatch_)
   */
  static _evaluateMatch(row, headers, query) {
    for (const key in query) {
      const colIndex = headers.indexOf(key);
      if (colIndex === -1) throw new Error(`Coluna '${key}' não encontrada.`);

      const queryValue = query[key];
      const cellValue = row[colIndex] === undefined ? '' : row[colIndex];

      if (queryValue !== null && typeof queryValue === 'object') {
        if (queryValue['$ne'] !== undefined && cellValue == queryValue['$ne']) return false;
        if (queryValue['$gt'] !== undefined && cellValue <= queryValue['$gt']) return false;
        if (queryValue['$gte'] !== undefined && cellValue < queryValue['$gte']) return false;
        if (queryValue['$lt'] !== undefined && cellValue >= queryValue['$lt']) return false;
        if (queryValue['$lte'] !== undefined && cellValue > queryValue['$lte']) return false;
        if (queryValue['$in'] !== undefined && Array.isArray(queryValue['$in'])) {
          if (!queryValue['$in'].some((val) => val == cellValue)) return false;
        }
        if (queryValue['$nin'] !== undefined && Array.isArray(queryValue['$nin'])) {
          if (queryValue['$nin'].some((val) => val == cellValue)) return false;
        }
        if (queryValue['$contains'] !== undefined) {
          const searchStr = String(queryValue['$contains']).toLowerCase();
          const cellStr = String(cellValue).toLowerCase();
          if (!cellStr.includes(searchStr)) return false;
        }
      } else if (cellValue != queryValue) {
        return false;
      }
    }
    return true;
  }

  /** Lê a aba inteira. Retorna { headers: string[], data: any[][] } (data sem o cabeçalho). */
  static async _readSheet(sheets, spreadsheetId, sheetName) {
    let response;
    try {
      response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: quoteSheet(sheetName),
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
    } catch (error) {
      if (error.code === 400 && /Unable to parse range/i.test(error.message)) {
        throw new Error(`Aba não encontrada: ${sheetName}`);
      }
      throw error;
    }

    const rows = response.data.values;
    if (!rows || rows.length === 0) return { headers: [], data: [] };

    return { headers: rows[0].map((h) => String(h)), data: rows.slice(1) };
  }

  /** Helper para buscar o gridId (necessário para deleções na API v4) */
  static async _getSheetId(sheets, spreadsheetId, sheetName) {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(sheetId,title)',
    });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Aba não encontrada: ${sheetName}`);
    return sheet.properties.sheetId;
  }

  /**
   * @param {string[]} [returnColumns] - se informado, retorna apenas essas colunas
   */
  static async getRows(spreadsheetId, sheetName, queryJson = {}, returnColumns = null) {
    const sheets = await getSheetsClient();
    const { headers, data } = await this._readSheet(sheets, spreadsheetId, sheetName);
    if (data.length === 0) return [];

    return data
      .filter((row) => this._evaluateMatch(row, headers, queryJson))
      .map((row) => {
        const obj = {};
        headers.forEach((header, index) => {
          if (!returnColumns || returnColumns.includes(header)) {
            obj[header] = row[index] === undefined ? '' : row[index];
          }
        });
        return obj;
      });
  }

  static async postRows(spreadsheetId, sheetName, jsonData) {
    const sheets = await getSheetsClient();
    const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
    if (dataArray.length === 0) return;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheet(sheetName)}!1:1`,
    });

    const headers = response.data.values && response.data.values[0];
    if (!headers || headers.length === 0) {
      throw new Error(`A aba '${sheetName}' não possui cabeçalhos na linha 1.`);
    }

    const matrix = dataArray.map((obj) =>
      headers.map((header) => (Object.prototype.hasOwnProperty.call(obj, header) ? sanitizeValue(obj[header]) : ''))
    );

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheet(sheetName)}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: matrix },
    });
  }

  /** Atualiza (só as colunas informadas) todas as linhas que casam com a query. Retorna a qtde de linhas. */
  static async patchRows(spreadsheetId, sheetName, queryJson, updateData) {
    const sheets = await getSheetsClient();
    const { headers, data } = await this._readSheet(sheets, spreadsheetId, sheetName);
    if (data.length === 0) return 0;

    const updates = [];
    let affectedRows = 0;

    data.forEach((row, i) => {
      if (!this._evaluateMatch(row, headers, queryJson)) return;
      affectedRows++;

      for (const key in updateData) {
        if (updateData[key] === undefined) continue;
        const colIndex = headers.indexOf(key);
        if (colIndex === -1) continue;
        updates.push({
          range: `${quoteSheet(sheetName)}!${columnLetter(colIndex)}${i + 2}`,
          values: [[sanitizeValue(updateData[key])]],
        });
      }
    });

    if (updates.length === 0) return affectedRows;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });

    return affectedRows;
  }

  /**
   * Como getRows, mas lê SÓ as colunas necessárias (as de returnColumns + as usadas na query).
   * Use em abas grandes com colunas pesadas (ex.: "Log", com listas de IDs): getRows leria tudo.
   */
  static async getRowsPartial(spreadsheetId, sheetName, queryJson = {}, returnColumns = []) {
    const sheets = await getSheetsClient();
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheet(sheetName)}!1:1`,
    });
    const headers = ((headerResponse.data.values && headerResponse.data.values[0]) || []).map((h) => String(h));
    if (headers.length === 0) return [];

    const needed = [...new Set([...returnColumns, ...Object.keys(queryJson)])];
    const missing = needed.find((name) => !headers.includes(name));
    if (missing) throw new Error(`Coluna '${missing}' não encontrada.`);

    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: needed.map((name) => {
        const letter = columnLetter(headers.indexOf(name));
        return `${quoteSheet(sheetName)}!${letter}2:${letter}`;
      }),
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    // Cada coluna volta como lista (sem as células vazias do final): alinha pelo índice da linha
    const columns = response.data.valueRanges.map((vr) => (vr.values || []).map((cell) => (cell[0] === undefined ? '' : cell[0])));
    const rowCount = Math.max(0, ...columns.map((c) => c.length));

    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const record = {};
      needed.forEach((name, c) => {
        record[name] = columns[c][i] === undefined ? '' : columns[c][i];
      });
      if (this._evaluateMatch(needed.map((n) => record[n]), needed, queryJson)) {
        const out = {};
        returnColumns.forEach((name) => {
          out[name] = record[name];
        });
        rows.push(out);
      }
    }
    return rows;
  }

  /**
   * Atualiza (só as colunas informadas) as linhas em que keyColumn == keyValue, lendo apenas a coluna-chave.
   * Retorna a quantidade de linhas atualizadas.
   */
  static async patchByKey(spreadsheetId, sheetName, keyColumn, keyValue, updateData) {
    const sheets = await getSheetsClient();
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheet(sheetName)}!1:1`,
    });
    const headers = ((headerResponse.data.values && headerResponse.data.values[0]) || []).map((h) => String(h));
    const keyIndex = headers.indexOf(keyColumn);
    if (keyIndex === -1) throw new Error(`Coluna '${keyColumn}' não encontrada.`);

    const keyLetter = columnLetter(keyIndex);
    const keyResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheet(sheetName)}!${keyLetter}2:${keyLetter}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const keys = keyResponse.data.values || [];

    const updates = [];
    let affectedRows = 0;
    keys.forEach((cell, i) => {
      if (cell[0] === undefined || cell[0] != keyValue) return;
      affectedRows++;
      for (const key in updateData) {
        if (updateData[key] === undefined) continue;
        const colIndex = headers.indexOf(key);
        if (colIndex === -1) continue;
        updates.push({
          range: `${quoteSheet(sheetName)}!${columnLetter(colIndex)}${i + 2}`,
          values: [[sanitizeValue(updateData[key])]],
        });
      }
    });

    if (updates.length === 0) return affectedRows;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
    return affectedRows;
  }

  static async deleteRows(spreadsheetId, sheetName, queryJson) {
    const sheets = await getSheetsClient();
    const sheetId = await this._getSheetId(sheets, spreadsheetId, sheetName);
    const { headers, data } = await this._readSheet(sheets, spreadsheetId, sheetName);
    if (data.length === 0) return;

    const requests = [];
    // De trás para frente, para não bagunçar os índices ao deletar
    for (let i = data.length - 1; i >= 0; i--) {
      if (this._evaluateMatch(data[i], headers, queryJson)) {
        requests.push({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: i + 1, endIndex: i + 2 },
          },
        });
      }
    }

    if (requests.length === 0) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

module.exports = SheetsDB;
