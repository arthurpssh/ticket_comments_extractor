const crypto = require('crypto');
const SheetsDB = require('../utils/SheetsDB');
const { HttpError } = require('../utils/errors');
const { withLock } = require('../utils/mutex');
const { localDay } = require('../utils/dates');
const { controlSpreadsheetId, sheets, configKeys, limits, roles } = require('../config/extraction');
const { getQuotaConfig, setConfigValue } = require('./configService');
const ledger = require('./ledgerService');

// As colunas da aba são texto: "" = não preenchido
function parseCount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n < 0 ? null : n;
}

const sameUser = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Lê o usuário na aba "Use Controller" e calcula cota e saldo efetivos. */
async function findUser(email, config) {
  const rows = await SheetsDB.getRows(controlSpreadsheetId, sheets.uses);
  const row = rows.find((r) => sameUser(r.user, email));
  if (!row) return { row: null };

  // Sem a coluna, o saldo não seria gravado e o limite deixaria de valer: falha explícita
  if (!('tickets_left' in row)) throw new Error(`Coluna 'tickets_left' não encontrada na aba '${sheets.uses}'.`);

  const quota = parseCount(row.daily_quota) ?? config.dailyTickets;
  // tickets_left em branco (ainda não houve reset com a coluna nova) = cota cheia do dia
  const ticketsLeft = parseCount(row.tickets_left) ?? quota;
  const isAdmin = String(row.role).trim().toLowerCase() === roles.admin;

  return { row, quota, ticketsLeft, isAdmin };
}

const setTicketsLeft = (row, value) =>
  SheetsDB.patchRows(controlSpreadsheetId, sheets.uses, { user: row.user }, { tickets_left: String(value) });

/** Situação de uso do usuário, sem consumir nada. */
async function getUsageStatus(email) {
  const config = await getQuotaConfig();
  const { row, quota, ticketsLeft, isAdmin } = await findUser(email, config);

  return {
    user: email,
    registered: Boolean(row),
    is_admin: Boolean(row && isAdmin),
    tickets_left: row ? ticketsLeft : 0,
    daily_quota: row ? quota : 0,
    global_remaining: Math.max(0, config.globalDailyTickets - config.globalUsedToday),
    max_tickets: limits.maxTickets,
  };
}

/** O usuário é admin? (aba "Use Controller", coluna role) */
async function isAdmin(email) {
  const config = await getQuotaConfig();
  const user = await findUser(email, config);
  return Boolean(user.row && user.isAdmin);
}

/**
 * Valida e consome `amount` tickets do saldo do usuário e do teto global do dia.
 * Retorna os tickets restantes do usuário.
 */
function consume(email, amount, ref) {
  return withLock(async () => {
    const config = await getQuotaConfig();
    const { row, ticketsLeft } = await findUser(email, config);

    if (!row) throw new HttpError(403, 'Sem tickets restantes: usuário não cadastrado no controle de uso.');
    if (ticketsLeft <= 0) throw new HttpError(403, 'Sem tickets restantes hoje. A cota é renovada diariamente.');
    if (amount > ticketsLeft) {
      throw new HttpError(403, `Saldo insuficiente: você tem ${ticketsLeft} ticket(s) restante(s) hoje e solicitou ${amount}.`);
    }

    const globalRemaining = config.globalDailyTickets - config.globalUsedToday;
    if (amount > globalRemaining) {
      throw new HttpError(
        429,
        `O limite diário de tickets de toda a equipe foi atingido (restam ${Math.max(0, globalRemaining)} hoje). Tente novamente amanhã.`
      );
    }

    await setTicketsLeft(row, ticketsLeft - amount);
    try {
      await setConfigValue(configKeys.globalUsedToday, config.globalUsedToday + amount);
    } catch (error) {
      await setTicketsLeft(row, ticketsLeft).catch(() => {});
      throw error;
    }

    await ledger.record({ user: row.user, type: 'consume', delta: -amount, ref });
    return ticketsLeft - amount;
  });
}

/**
 * Devolve `amount` tickets (falhas técnicas). Só vale no mesmo dia da extração: depois do reset
 * diário a cota já foi renovada e devolver passaria do limite.
 */
function refund(email, amount, { ref, day }) {
  return withLock(async () => {
    if (amount <= 0 || day !== localDay()) return false;

    const config = await getQuotaConfig();
    const { row, ticketsLeft } = await findUser(email, config);
    if (!row) return false;

    await setTicketsLeft(row, ticketsLeft + amount);
    await setConfigValue(configKeys.globalUsedToday, Math.max(0, config.globalUsedToday - amount)).catch((error) =>
      console.error('[usage] falha ao devolver ao contador global:', error.message)
    );
    await ledger.record({ user: row.user, type: 'refund', delta: amount, ref });
    return true;
  });
}

/** O usuário doa parte do próprio saldo do dia para outro usuário cadastrado. */
function transfer(fromEmail, toEmail, amount) {
  return withLock(async () => {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Informe uma quantidade inteira maior que zero.');
    if (sameUser(fromEmail, toEmail)) throw new HttpError(400, 'Você não pode doar tickets para si mesmo.');

    const config = await getQuotaConfig();
    const donor = await findUser(fromEmail, config);
    if (!donor.row) throw new HttpError(403, 'Seu usuário não está cadastrado no controle de uso.');

    const recipient = await findUser(toEmail, config);
    if (!recipient.row) throw new HttpError(404, 'O destinatário não está cadastrado no controle de uso.');

    if (n > donor.ticketsLeft) {
      throw new HttpError(400, `Você só tem ${donor.ticketsLeft} ticket(s) disponível(is) para doar hoje.`);
    }

    await setTicketsLeft(donor.row, donor.ticketsLeft - n);
    try {
      await setTicketsLeft(recipient.row, recipient.ticketsLeft + n);
    } catch (error) {
      await setTicketsLeft(donor.row, donor.ticketsLeft).catch(() => {});
      throw error;
    }

    const ref = crypto.randomUUID();
    await ledger.record({ user: donor.row.user, type: 'transfer_out', delta: -n, ref, note: `para ${recipient.row.user}` });
    await ledger.record({ user: recipient.row.user, type: 'transfer_in', delta: n, ref, note: `de ${donor.row.user}` });

    return { tickets_left: donor.ticketsLeft - n, recipient: recipient.row.user };
  });
}

/** E-mails cadastrados (para escolher o destinatário de uma doação). */
async function listRegisteredEmails() {
  const rows = await SheetsDB.getRows(controlSpreadsheetId, sheets.uses, {}, ['user']);
  return rows
    .map((r) => String(r.user).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

module.exports = { getUsageStatus, isAdmin, consume, refund, transfer, listRegisteredEmails, parseCount };
