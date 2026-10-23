const SheetsDB = require('../utils/SheetsDB');
const { controlSpreadsheetId, sheets } = require('../config/extraction');

/** Registra o início de uma extração na aba "Log" com status "processing". */
async function logStart({ logId, user, ticketIds }) {
  await SheetsDB.postRows(controlSpreadsheetId, sheets.log, {
    log_id: logId,
    date: new Date().toISOString(),
    user,
    ticket_amount: String(ticketIds.length),
    ticket_ids: JSON.stringify(ticketIds),
    status: 'processing',
  });
}

/**
 * Atualiza a linha identificada por log_id.
 * status: "success" | "partial" | "failed"; failedTickets: IDs pulados; apiCalls: chamadas HTTP reais ao Zendesk.
 * (A aba Log é grande e tem colunas pesadas: a busca lê só a coluna log_id.)
 */
async function logFinish(logId, { status, failedTickets = [], apiCalls = 0 }) {
  const updated = await SheetsDB.patchByKey(controlSpreadsheetId, sheets.log, 'log_id', logId, {
    status,
    failed_tickets: failedTickets.length > 0 ? JSON.stringify(failedTickets) : '',
    api_calls: String(apiCalls),
  });
  if (updated === 0) throw new Error(`Log ${logId} não encontrado para atualizar o status para '${status}'.`);
}

module.exports = { logStart, logFinish };
