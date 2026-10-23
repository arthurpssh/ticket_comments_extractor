const { zendesk, limits } = require('../config/extraction');
const { HttpError } = require('./errors');
const { RateLimiter } = require('./rateLimiter');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Limitador global: todas as extrações compartilham o mesmo ritmo de pedidos ao Zendesk
const limiter = new RateLimiter({ maxRpm: limits.zendeskMaxRpm, guardRatio: limits.zendeskGuardRatio });
console.log(`[zendesk] limitador: no máximo ${limits.zendeskMaxRpm} pedidos/min`);

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------
// OAuth client credentials: o token fica SOMENTE em memória deste processo (nada em disco, planilha
// ou log). Não há refresh token: renovar = pedir outro token com as mesmas credenciais.
// Sem OAuth configurado, usa o Basic token legado.

const TOKEN_SKEW_MS = 60 * 1000; // renova um pouco antes de vencer
const DEFAULT_TOKEN_TTL_S = 3600; // quando o Zendesk não informa expires_in

let cachedToken = null; // { value, expiresAt }
let tokenRequest = null; // Promise em andamento (várias requisições compartilham a mesma busca)

console.log(`[zendesk] autenticação: ${zendesk.oauth ? 'OAuth client credentials (Bearer)' : 'Basic token (legado)'}`);

const TLS_CODES = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'];
const NETWORK_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'];

// O fetch do Node só diz "fetch failed"; o motivo real (DNS, TLS, proxy...) vem em error.cause
function describeNetworkError(error) {
  const cause = error && error.cause;
  const code = cause && (cause.code || cause.name);
  const detail = [code, cause && cause.message].filter(Boolean).join(' - ');

  let hint = '';
  if (TLS_CODES.includes(code)) hint = ' Provável inspeção TLS/proxy corporativo: aponte NODE_EXTRA_CA_CERTS para o certificado raiz da empresa.';
  else if (NETWORK_CODES.includes(code)) hint = ' Verifique VPN/proxy/DNS e o valor de ZENDESK_BASE_URL.';

  return `${error.message}${detail ? ` (${detail})` : ''}.${hint}`;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function requestAccessToken() {
  const { clientId, clientSecret, scope, expiresIn } = zendesk.oauth;
  const body = { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope };
  if (expiresIn) body.expires_in = expiresIn;

  let response;
  try {
    response = await fetch(`${zendesk.oauthUrl}/oauth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw Object.assign(new HttpError(502, `Falha de rede ao obter o token OAuth do Zendesk: ${describeNetworkError(error)}`), { fatal: true });
  }

  const json = await readJson(response);
  if (!response.ok || !json || !json.access_token) {
    const reason = (json && (json.error_description || json.error || json.description)) || 'sem detalhes';
    const hint = [400, 401].includes(response.status) ? ' Verifique ZENDESK_CLIENT_ID/ZENDESK_CLIENT_SECRET e o escopo do client.' : '';
    // O escopo solicitado não é segredo e ajuda a diagnosticar; o client_secret nunca entra na mensagem
    throw Object.assign(
      new HttpError(502, `Falha ao obter o token OAuth do Zendesk (${response.status}): ${reason}.${hint} Escopo solicitado: "${scope}".`),
      { fatal: true }
    );
  }

  const ttlSeconds = Number(json.expires_in) > 0 ? Number(json.expires_in) : DEFAULT_TOKEN_TTL_S;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
  return cachedToken.value;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_SKEW_MS) return cachedToken.value;
  if (!tokenRequest) {
    tokenRequest = requestAccessToken().finally(() => {
      tokenRequest = null;
    });
  }
  return tokenRequest;
}

// Descarta o token só se ainda for o mesmo que falhou (outra requisição pode já ter renovado)
function invalidateToken(usedToken) {
  if (cachedToken && cachedToken.value === usedToken) cachedToken = null;
}

async function getAuth() {
  if (!zendesk.oauth) return { header: `Basic ${zendesk.basicToken}`, token: null };
  const token = await getAccessToken();
  return { header: `Bearer ${token}`, token };
}

// ---------------------------------------------------------------------------
// Requisições
// ---------------------------------------------------------------------------

/**
 * Requisição à API do Zendesk, com retry exponencial em 429/5xx (equivalente ao Utils.sendRequest do GAS).
 * Erros 4xx (exceto 429) não são repetidos. Em 401 com OAuth, renova o token e repete uma única vez.
 */
async function request(path, { method = 'GET', body, retries = 3, onCall } = {}) {
  const url = `${zendesk.baseUrl}${path}`;
  let wait = 1000;
  let attempt = 0;
  let authRetried = false;

  for (;;) {
    const auth = await getAuth();

    let response;
    try {
      await limiter.acquire();
      if (onCall) onCall(); // contabiliza cada chamada HTTP real (inclui retries)
      response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: auth.header },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      limiter.observe(response.headers);
    } catch (error) {
      if (attempt >= retries) throw new HttpError(502, `Falha de rede ao acessar o Zendesk: ${describeNetworkError(error)}`);
      await sleep(wait);
      wait *= 2;
      attempt++;
      continue;
    }

    // Token revogado/expirado antes do previsto: renova e repete (a requisição não foi processada)
    if (response.status === 401 && auth.token && !authRetried) {
      await response.text();
      invalidateToken(auth.token);
      authRetried = true;
      continue;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      await response.text();
      // Retry-After (segundos) manda quando presente; senão, espera exponencial
      const header = response.headers.get('retry-after');
      const retryAfter = header === null ? NaN : Number(header);
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : wait;
      if (response.status === 429) limiter.pause(delay); // todas as extrações esperam
      await sleep(delay);
      wait *= 2;
      attempt++;
      continue;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) throw zendeskError(response.status, json, text);
    return json;
  }
}

function zendeskError(status, json, text) {
  const parts = [];
  if (json && (json.description || json.error)) {
    parts.push(typeof json.error === 'string' ? json.error : json.description);
    if (json.description && json.error !== json.description) parts.push(json.description);
  }
  if (json && json.details) parts.push(JSON.stringify(json.details));
  const detail = parts.length > 0 ? parts.join(' - ') : String(text || '').slice(0, 300);

  // 404 do Zendesk vira 404; qualquer outra falha do Zendesk é "bad gateway" para o cliente
  const httpStatus = status === 404 ? 404 : 502;
  const error = new HttpError(httpStatus, `Zendesk respondeu ${status}${detail ? `: ${detail}` : ''}`);
  error.zendeskStatus = status;
  return error;
}

/**
 * Uma página de comentários do ticket (com os usuários referenciados).
 * Retorna { comments, users, hasNext }. Lança HttpError(404) se o ticket não existe.
 */
async function getTicketCommentsPage(ticketId, page, onCall) {
  const data = await request(`/tickets/${encodeURIComponent(ticketId)}/comments?include=users&page=${page}`, { onCall });
  return {
    comments: (data && data.comments) || [],
    users: (data && data.users) || [],
    hasNext: Boolean(data && data.next_page),
  };
}

/** Erros que afetam todos os tickets (credencial/permissão): não adianta pular o ticket. */
function isFatalError(error) {
  return Boolean(error && (error.fatal || error.zendeskStatus === 401 || error.zendeskStatus === 403));
}

module.exports = { getTicketCommentsPage, isFatalError, sleep, limiter };
