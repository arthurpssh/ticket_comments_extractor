const SheetsDB = require('../utils/SheetsDB');
const { controlSpreadsheetId, sheets } = require('../config/extraction');

/**
 * Registro de auditoria da cota (aba "Quota Ledger").
 * type: consume | refund | transfer_out | transfer_in | admin_adjust (| reset, gravado pelo Apps Script)
 * Falha ao gravar o ledger nunca impede a operação: só é registrada no log do servidor.
 */
async function record({ user, type, delta, ref = '', note = '' }) {
  try {
    await SheetsDB.postRows(controlSpreadsheetId, sheets.ledger, {
      date: new Date().toISOString(),
      user,
      type,
      delta,
      ref,
      note,
    });
  } catch (error) {
    console.error(`[ledger] falha ao registrar ${type} de ${user}:`, error.message);
  }
}

module.exports = { record };
