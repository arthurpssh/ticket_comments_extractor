const SheetsDB = require('../utils/SheetsDB');
const { controlSpreadsheetId, sheets, configKeys, defaults } = require('../config/extraction');

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n < 0 ? fallback : n;
}

/** Lê a aba Config (key, value) e devolve os valores já interpretados, com os padrões quando ausentes. */
async function getQuotaConfig() {
  const rows = await SheetsDB.getRows(controlSpreadsheetId, sheets.config);
  const map = new Map(rows.map((r) => [String(r.key).trim(), r.value]));

  return {
    dailyTickets: toInt(map.get(configKeys.dailyTickets), defaults.dailyTickets),
    globalDailyTickets: toInt(map.get(configKeys.globalDailyTickets), defaults.globalDailyTickets),
    globalUsedToday: toInt(map.get(configKeys.globalUsedToday), 0),
    legacyDailyUse: toInt(map.get(configKeys.legacyDailyUse), defaults.legacyDailyUse),
  };
}

/** Grava (ou cria) uma chave da aba Config. */
async function setConfigValue(key, value) {
  const updated = await SheetsDB.patchRows(controlSpreadsheetId, sheets.config, { key }, { value: String(value) });
  if (!updated) await SheetsDB.postRows(controlSpreadsheetId, sheets.config, { key, value: String(value) });
}

module.exports = { getQuotaConfig, setConfigValue };
