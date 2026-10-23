const SheetsDB = require('../utils/SheetsDB');
const { HttpError } = require('../utils/errors');
const { withLock } = require('../utils/mutex');
const { localDay, localHour } = require('../utils/dates');
const { controlSpreadsheetId, sheets, configKeys, roles, allowedEmailRegex } = require('../config/extraction');
const { getQuotaConfig, setConfigValue } = require('./configService');
const { parseCount } = require('./usageService');
const ledger = require('./ledgerService');

const LOG_STATUSES = ['processing', 'success', 'partial', 'failed'];
const LEDGER_TYPES = ['consume', 'refund', 'transfer_out', 'transfer_in', 'admin_adjust', 'reset'];

const normalizeRole = (role) => (String(role).trim().toLowerCase() === roles.admin ? roles.admin : roles.user);

// ---------- Config ----------

async function getConfig() {
  const config = await getQuotaConfig();
  return {
    daily_tickets: config.dailyTickets,
    global_daily_tickets: config.globalDailyTickets,
    global_used_today: config.globalUsedToday,
  };
}

function setConfig(payload) {
  const updates = [];
  if (payload.daily_tickets !== undefined) updates.push([configKeys.dailyTickets, payload.daily_tickets, 0, 20000, 'Cota diária por pessoa']);
  if (payload.global_daily_tickets !== undefined) {
    updates.push([configKeys.globalDailyTickets, payload.global_daily_tickets, 0, 1000000, 'Teto global diário']);
  }
  if (updates.length === 0) throw new HttpError(400, 'Nada para atualizar.');

  updates.forEach(([, value, min, max, label]) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}: informe um inteiro entre ${min} e ${max}.`);
  });

  return withLock(async () => {
    for (const [key, value] of updates) await setConfigValue(key, Number(value));
    return getConfig();
  });
}

// ---------- Usuários ----------

async function listUsers() {
  const config = await getQuotaConfig();
  const rows = await SheetsDB.getRows(controlSpreadsheetId, sheets.uses);

  return rows
    .filter((r) => String(r.user).trim() !== '')
    .map((r) => {
      const quota = parseCount(r.daily_quota);
      return {
        user: String(r.user).trim(),
        tickets_left: parseCount(r.tickets_left) ?? quota ?? config.dailyTickets,
        daily_quota: quota, // null = usa o padrão
        uses_left: parseCount(r.uses_left) ?? 0, // legado (extrator antigo)
        role: normalizeRole(r.role),
      };
    });
}

function updateUser(currentEmail, p) {
  const user = String(p.user || '').trim();
  if (!user) throw new HttpError(400, 'Usuário não informado.');

  const update = {};
  if (p.tickets_left !== undefined) {
    const n = Number(p.tickets_left);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Tickets restantes deve ser um inteiro maior ou igual a 0.');
    update.tickets_left = String(n);
  }
  if (p.daily_quota !== undefined) {
    if (p.daily_quota === null || p.daily_quota === '') {
      update.daily_quota = ''; // volta ao padrão
    } else {
      const n = Number(p.daily_quota);
      if (!Number.isInteger(n) || n < 0 || n > 20000) throw new HttpError(400, 'Cota diária: informe um inteiro entre 0 e 20000 (ou vazio para o padrão).');
      update.daily_quota = String(n);
    }
  }
  if (p.role !== undefined) {
    if (!Object.values(roles).includes(p.role)) throw new HttpError(400, 'Papel inválido.');
    if (user.toLowerCase() === currentEmail && p.role !== roles.admin) {
      throw new HttpError(400, 'Você não pode remover o seu próprio acesso de admin.');
    }
    update.role = p.role;
  }
  if (Object.keys(update).length === 0) throw new HttpError(400, 'Nada para atualizar.');

  return withLock(async () => {
    let previous = null;
    if (update.tickets_left !== undefined) {
      const rows = await SheetsDB.getRows(controlSpreadsheetId, sheets.uses, { user });
      previous = rows[0] ? parseCount(rows[0].tickets_left) : null;
      if (previous === null && rows[0]) previous = parseCount(rows[0].daily_quota) ?? (await getQuotaConfig()).dailyTickets;
    }

    const count = await SheetsDB.patchRows(controlSpreadsheetId, sheets.uses, { user }, update);
    if (!count) throw new HttpError(404, 'Usuário não encontrado.');

    if (previous !== null) {
      const delta = Number(update.tickets_left) - previous;
      if (delta !== 0) await ledger.record({ user, type: 'admin_adjust', delta, note: `por ${currentEmail}` });
    }
    return { user, ...update };
  });
}

function deleteUser(currentEmail, userRaw) {
  const user = String(userRaw || '').trim();
  if (!user) throw new HttpError(400, 'Usuário não informado.');
  if (user.toLowerCase() === currentEmail) throw new HttpError(400, 'Você não pode excluir o seu próprio usuário.');

  return withLock(async () => {
    await SheetsDB.deleteRows(controlSpreadsheetId, sheets.uses, { user });
    return { user };
  });
}

function addUsers(raw) {
  const tokens = String(raw || '')
    .split(/[,;\n\r]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) throw new HttpError(400, 'Informe ao menos um e-mail.');

  return withLock(async () => {
    const config = await getQuotaConfig();
    const existing = new Set((await listUsers()).map((u) => u.user.toLowerCase()));
    const seen = new Set();
    const added = [];
    const duplicated = [];
    const invalid = [];

    tokens.forEach((t) => {
      if (!allowedEmailRegex.test(t)) return invalid.push(t);
      if (existing.has(t) || seen.has(t)) return duplicated.push(t);
      seen.add(t);
      return added.push(t);
    });

    if (added.length > 0) {
      const now = new Date().toISOString();
      await SheetsDB.postRows(
        controlSpreadsheetId,
        sheets.uses,
        added.map((user) => ({
          user,
          tickets_left: String(config.dailyTickets),
          uses_left: String(config.legacyDailyUse), // o extrator antigo (Apps Script) ainda lê esta coluna
          refreshed_at: now,
          role: roles.user,
          daily_quota: '',
        }))
      );
    }
    return { added, duplicated, invalid, users: await listUsers() };
  });
}

// ---------- Analytics ----------

const DAY_MS = 86400000;
const pad = (n) => (n < 10 ? '0' : '') + n;
const toUtc = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/**
 * Filtros: { start:'yyyy-MM-dd', end:'yyyy-MM-dd', user:'' (todos), status:'' (todos) }
 * Granularidade (dias inclusivos no período): 1 -> hora | 2 -> 6h | 3+ -> dia
 */
async function getAnalytics(f) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(f.start || '') || !DATE_RE.test(f.end || '')) throw new HttpError(400, 'Período inválido.');
  if (f.start > f.end) throw new HttpError(400, 'A data inicial é maior que a final.');
  if (f.status && !LOG_STATUSES.includes(f.status)) throw new HttpError(400, 'Status inválido.');

  const days = Math.round((toUtc(f.end) - toUtc(f.start)) / DAY_MS) + 1;
  if (days > 366) throw new HttpError(400, 'O período máximo é de 366 dias.');
  const granularity = days === 1 ? 'hour' : days === 2 ? '6h' : 'day';
  const stepMs = granularity === 'hour' ? 3600000 : granularity === '6h' ? 6 * 3600000 : DAY_MS;

  const keyOf = (ms) => {
    const d = new Date(ms);
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return granularity === 'day' ? day : `${day} ${pad(d.getUTCHours())}`;
  };
  const labelOf = (key) => {
    const dm = `${key.slice(8, 10)}/${key.slice(5, 7)}`;
    return granularity === 'day' ? dm : `${dm} ${key.slice(11, 13)}h`;
  };

  // Buckets zerados; o horário local é representado via UTC apenas para a aritmética
  const buckets = [];
  const index = {};
  for (let t = toUtc(f.start); t < toUtc(f.end) + DAY_MS; t += stepMs) {
    const key = keyOf(t);
    index[key] = buckets.length;
    buckets.push({ key, label: labelOf(key), processing: 0, success: 0, partial: 0, failed: 0, tickets: 0, api_calls: 0 });
  }

  const query = {};
  if (f.user) query.user = f.user;
  if (f.status) query.status = f.status;
  // A aba Log tem colunas pesadas (ticket_ids): lê só as necessárias
  const logs = await SheetsDB.getRowsPartial(controlSpreadsheetId, sheets.log, query, ['date', 'user', 'ticket_amount', 'status', 'api_calls']);

  const ranking = {};
  const totals = { calls: 0, tickets: 0, api_calls: 0 };

  logs.forEach((l) => {
    const d = new Date(l.date);
    if (Number.isNaN(d.getTime())) return;
    const day = localDay(d);
    const hour = localHour(d);
    if (day < f.start || day > f.end) return;

    let key = day;
    if (granularity === 'hour') key = `${day} ${pad(hour)}`;
    if (granularity === '6h') key = `${day} ${pad(Math.floor(hour / 6) * 6)}`;
    const b = buckets[index[key]];
    if (!b) return;

    const status = LOG_STATUSES.includes(l.status) ? l.status : null;
    const tickets = Number(l.ticket_amount) || 0;
    const apiCalls = Number(l.api_calls) || 0;
    if (status) b[status]++;
    b.tickets += tickets;
    b.api_calls += apiCalls;

    const u = String(l.user).trim();
    const r = ranking[u] || (ranking[u] = { user: u, calls: 0, tickets: 0, api_calls: 0 });
    r.calls++;
    r.tickets += tickets;
    r.api_calls += apiCalls;
    totals.calls++;
    totals.tickets += tickets;
    totals.api_calls += apiCalls;
  });

  return {
    granularity,
    buckets,
    totals,
    ranking: Object.values(ranking).sort((a, b) => b.tickets - a.tickets),
    users: (await listUsers()).map((u) => u.user).sort(),
  };
}

// ---------- Ledger ----------

/** Últimos movimentos da cota (mais recentes primeiro). Filtros opcionais: user, type. */
async function getLedger({ user, type, limit = 200 }) {
  if (type && !LEDGER_TYPES.includes(type)) throw new HttpError(400, 'Tipo inválido.');
  const query = {};
  if (user) query.user = user;
  if (type) query.type = type;

  const rows = await SheetsDB.getRows(controlSpreadsheetId, sheets.ledger, query, ['date', 'user', 'type', 'delta', 'ref', 'note']);
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  return rows.slice(-max).reverse();
}

module.exports = { getConfig, setConfig, listUsers, updateUser, deleteUser, addUsers, getAnalytics, getLedger, LOG_STATUSES };
