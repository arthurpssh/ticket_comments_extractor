// src/config/extraction.js
// Configuração central da aplicação (planilha de controle, Zendesk, limites).

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

/**
 * Autenticação no Zendesk. Dois modos (o OAuth tem prioridade quando configurado):
 *  - OAuth "client credentials": ZENDESK_CLIENT_ID + ZENDESK_CLIENT_SECRET -> Bearer com validade curta,
 *    renovado automaticamente (ver utils/zendeskClient.js).
 *  - Fallback Basic: ZENDESK_BASIC_TOKEN (base64 de "email/token:api_token").
 */
function zendeskConfig() {
  const baseUrl = (process.env.ZENDESK_BASE_URL || 'https://suportehotmart.zendesk.com/api/v2').replace(/\/+$/, '');
  const clientId = (process.env.ZENDESK_CLIENT_ID || '').trim();
  const clientSecret = (process.env.ZENDESK_CLIENT_SECRET || '').trim();
  const basicToken = (process.env.ZENDESK_BASIC_TOKEN || '').trim();

  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('ZENDESK_CLIENT_ID e ZENDESK_CLIENT_SECRET devem ser definidos juntos');
  }
  if (!clientId && !basicToken) {
    throw new Error('Configure ZENDESK_CLIENT_ID + ZENDESK_CLIENT_SECRET (OAuth) ou ZENDESK_BASIC_TOKEN (fallback)');
  }

  const expiresIn = parseInt(process.env.ZENDESK_OAUTH_EXPIRES_IN, 10);

  return {
    baseUrl,
    // /oauth/tokens fica na raiz do subdomínio, fora de /api/v2
    oauthUrl: new URL(baseUrl).origin,
    oauth: clientId
      ? {
          clientId,
          clientSecret,
          scope: (process.env.ZENDESK_OAUTH_SCOPE || 'read write tickets:read macros:read macros:write').trim(),
          expiresIn: Number.isFinite(expiresIn) ? expiresIn : null, // segundos; vazio = padrão do Zendesk
        }
      : null,
    basicToken: basicToken || null,
  };
}

module.exports = {
  // Planilha de controle (abas "Use Controller" e "Log"). A service account precisa ser Editora dela.
  controlSpreadsheetId: required('CONTROL_SPREADSHEET_ID'),

  sheets: {
    // colunas: user, uses_left (legado), tickets_left, refreshed_at, role ('admin'|'user'), daily_quota (opcional)
    uses: 'Use Controller',
    // colunas: log_id, date, user, ticket_amount, ticket_ids, status, failed_tickets, api_calls
    log: 'Log',
    // colunas (key, value): daily_tickets, global_daily_tickets, global_used_today (+ daily_use, legado)
    config: 'Config',
    // colunas: date, user, type, delta, ref, note
    ledger: 'Quota Ledger',
  },

  // Chaves da aba Config
  configKeys: {
    dailyTickets: 'daily_tickets', // cota padrão de tickets por pessoa por dia
    globalDailyTickets: 'global_daily_tickets', // teto somado de todos os usuários por dia
    globalUsedToday: 'global_used_today', // contador do dia (zerado pelo Apps Script de controle)
    legacyDailyUse: 'daily_use', // acionamentos por dia do extrator antigo (Apps Script)
  },

  defaults: {
    dailyTickets: 1000,
    globalDailyTickets: 15000,
    legacyDailyUse: 2,
  },

  roles: { admin: 'admin', user: 'user' },
  // Quem pode ser cadastrado no controle de uso
  allowedEmailRegex: /^[a-z0-9._%+\-]+@(external\.)?hotmart\.com$/,

  zendesk: zendeskConfig(),

  limits: {
    maxTickets: 1000, // máximo de tickets por extração
    concurrency: 3, // tickets buscados em paralelo dentro de uma extração
    maxActiveJobs: 3, // extrações simultâneas no servidor
    pageDelayMs: 500, // pausa entre páginas de comentários de um mesmo ticket
    // Máximo de pedidos por minuto ao Zendesk, somando todas as extrações (o limite do plano é 700/min)
    zendeskMaxRpm: positiveInt(process.env.ZENDESK_MAX_RPM, 150),
    // Se o restante do limite do Zendesk cair abaixo desta fração, as extrações pausam (outros consumidores usando muito)
    zendeskGuardRatio: 0.5,
    abortAfterConsecutiveFailures: 10, // falhas seguidas que indicam indisponibilidade geral do Zendesk
    timeZone: 'America/Sao_Paulo',
    // Limite de caracteres por célula do Excel (o do Google Sheets é 50k, mas o xlsx é aberto no Excel)
    maxCellChars: 32000,
    jobTtlMs: 30 * 60 * 1000, // quanto tempo uma extração concluída fica disponível para download
  },

  // Apenas desenvolvimento local: simula o e-mail que o proxy de autenticação injetaria.
  // NÃO definir em produção (o header X-Auth-Request-Email é a fonte da identidade).
  devUserEmail: (process.env.DEV_USER_EMAIL || '').trim().toLowerCase(),
};
