const crypto = require('crypto');
const { HttpError } = require('../utils/errors');
const { limits } = require('../config/extraction');
const { getTicketCommentsPage, isFatalError, sleep } = require('../utils/zendeskClient');
const { formatComments } = require('../utils/commentsFormatter');
const { localDay } = require('../utils/dates');
const { buildXlsx } = require('./xlsxBuilder');
const usageService = require('./usageService');
const logService = require('./logService');

/**
 * Extrações em andamento / concluídas, mantidas em memória (a aplicação roda com 1 réplica).
 * Job: { id, user, status: 'starting'|'running'|'done'|'failed', partial, total, processed, notFound,
 *        failedTickets, refunded, apiCalls, error, filename, file (Buffer), day, startedAt, finishedAt }
 */
const jobs = new Map();

// Descarta extrações concluídas depois do TTL (libera o Buffer do arquivo)
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > limits.jobTtlMs) jobs.delete(id);
  }
}, 60 * 1000);
cleanup.unref();

const isActive = (job) => job.status === 'starting' || job.status === 'running';

function normalizeTicketIds(ticketList) {
  if (!Array.isArray(ticketList)) throw new HttpError(400, 'Lista de tickets inválida.');

  const ids = [...new Set(ticketList.map((t) => String(t).trim()).filter((t) => t !== ''))];

  if (ids.length === 0) throw new HttpError(400, 'Insira pelo menos um ID de ticket.');
  const invalid = ids.find((id) => !/^\d+$/.test(id));
  if (invalid) throw new HttpError(400, `ID de ticket inválido: ${invalid}`);
  if (ids.length > limits.maxTickets) {
    throw new HttpError(400, `Limite excedido: máximo de ${limits.maxTickets} tickets por extração (recebidos ${ids.length}).`);
  }
  return ids;
}

function toPublic(job) {
  return {
    job_id: job.id,
    status: job.status,
    partial: job.partial,
    total: job.total,
    processed: job.processed,
    not_found: job.notFound,
    failed_tickets: job.failedTickets,
    refunded: job.refunded,
    error: job.error || null,
    filename: job.status === 'done' ? job.filename : null,
  };
}

function findJobOf(email, predicate = () => true) {
  let found = null;
  for (const job of jobs.values()) {
    if (job.user === email && predicate(job) && (!found || job.startedAt > found.startedAt)) found = job;
  }
  return found;
}

const failureReason = (error) => (error && error.status ? error.message : 'erro inesperado');

/**
 * Busca todos os comentários de um ticket (todas as páginas).
 * Retorna { row, outcome: 'ok' | 'not_found' | 'failed' }. Erros fatais (credencial/permissão) são lançados.
 */
async function fetchTicket(ticketId, job) {
  const comments = [];
  const users = new Map();
  const onCall = () => {
    job.apiCalls++;
  };

  try {
    for (let page = 1; ; page++) {
      const result = await getTicketCommentsPage(ticketId, page, onCall);
      comments.push(...result.comments);
      result.users.forEach((u) => users.set(String(u.id), u));
      if (!result.hasNext) break;
      await sleep(limits.pageDelayMs);
    }
  } catch (error) {
    if (error.status === 404) {
      return { outcome: 'not_found', row: { ticket_id: ticketId, comments_concat: '[Ticket não encontrado no Zendesk]' } };
    }
    if (isFatalError(error)) throw error;

    // Falhou em todas as tentativas: o ticket é pulado e a extração segue
    console.error(`[extraction ${job.id}] ticket ${ticketId} pulado:`, error.message);
    return {
      outcome: 'failed',
      row: { ticket_id: ticketId, comments_concat: `[ERRO ao buscar este ticket: ${failureReason(error)}]` },
    };
  }

  return { outcome: 'ok', row: { ticket_id: ticketId, comments_concat: formatComments(comments, [...users.values()]) } };
}

async function finalizeLog(job, status) {
  try {
    await logService.logFinish(job.id, { status, failedTickets: job.failedTickets, apiCalls: job.apiCalls });
  } catch (logError) {
    console.error(`[extraction ${job.id}] falha ao registrar status ${status}:`, logError.message);
  }
}

async function refundTickets(job, amount) {
  if (amount <= 0) return;
  try {
    const done = await usageService.refund(job.user, amount, { ref: job.id, day: job.day });
    if (done) job.refunded = amount;
  } catch (error) {
    console.error(`[extraction ${job.id}] falha ao devolver ${amount} ticket(s):`, error.message);
  }
}

async function runJob(job, ticketIds) {
  try {
    const results = new Array(ticketIds.length);
    let next = 0;
    let abort = null;
    let consecutiveFailures = 0;

    const worker = async () => {
      while (!abort) {
        const index = next++;
        if (index >= ticketIds.length) return;
        try {
          const { row, outcome } = await fetchTicket(ticketIds[index], job);
          results[index] = row;
          job.processed++;
          if (outcome === 'not_found') job.notFound++;

          if (outcome === 'failed') {
            job.failedTickets.push(ticketIds[index]);
            consecutiveFailures++;
            if (consecutiveFailures >= limits.abortAfterConsecutiveFailures) {
              abort = new HttpError(502, `O Zendesk falhou em ${consecutiveFailures} tickets seguidos; a extração foi interrompida.`);
            }
          } else {
            consecutiveFailures = 0;
          }
        } catch (error) {
          abort = abort || error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, ticketIds.length) }, worker));
    if (abort) throw abort;
    if (job.failedTickets.length === ticketIds.length) {
      throw new HttpError(502, 'Nenhum ticket pôde ser extraído do Zendesk. Tente novamente mais tarde.');
    }

    job.file = await buildXlsx(results);
    job.filename = `Comentarios_tickets_${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
    job.partial = job.failedTickets.length > 0;
    job.status = 'done';
    job.finishedAt = Date.now();

    // Tickets pulados por erro técnico voltam para o saldo
    await refundTickets(job, job.failedTickets.length);
    await finalizeLog(job, job.partial ? 'partial' : 'success');
  } catch (error) {
    console.error(`[extraction ${job.id}] falhou:`, error);
    job.status = 'failed';
    job.error = error.status ? error.message : 'Erro interno ao gerar a planilha.';
    job.finishedAt = Date.now();

    // Nada foi entregue: o saldo inteiro volta
    await refundTickets(job, ticketIds.length);
    await finalizeLog(job, 'failed');
  }
}

/** Valida, consome os tickets da cota, registra o log e dispara a extração em segundo plano. */
async function start(email, ticketList) {
  const ticketIds = normalizeTicketIds(ticketList);

  if (findJobOf(email, isActive)) throw new HttpError(409, 'Você já possui uma extração em andamento.');
  const activeJobs = [...jobs.values()].filter(isActive).length;
  if (activeJobs >= limits.maxActiveJobs) {
    throw new HttpError(429, 'Há muitas extrações em andamento no momento. Tente novamente em alguns minutos.');
  }

  // Reserva o slot já (antes dos awaits) para impedir duas extrações simultâneas do mesmo usuário
  const job = {
    id: crypto.randomUUID(), // também é o log_id da linha na aba Log
    user: email,
    status: 'starting',
    partial: false,
    total: ticketIds.length,
    processed: 0,
    notFound: 0,
    failedTickets: [],
    refunded: 0,
    apiCalls: 0,
    error: null,
    filename: null,
    file: null,
    day: localDay(),
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  let ticketsLeft;
  try {
    ticketsLeft = await usageService.consume(email, ticketIds.length, job.id); // lança erro se não houver saldo
  } catch (error) {
    jobs.delete(job.id);
    throw error;
  }

  try {
    await logService.logStart({ logId: job.id, user: email, ticketIds });
  } catch (error) {
    console.error(`[extraction ${job.id}] falha ao registrar o log inicial:`, error);
    jobs.delete(job.id);
    await usageService
      .refund(email, ticketIds.length, { ref: job.id, day: job.day })
      .catch((e) => console.error('falha ao devolver os tickets:', e.message));
    throw new HttpError(502, 'Não foi possível registrar o log da extração. Seus tickets não foram descontados.');
  }

  job.status = 'running';
  runJob(job, ticketIds); // segundo plano: runJob trata os próprios erros

  return { ...toPublic(job), tickets_left: ticketsLeft };
}

function getJob(email, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.user !== email) throw new HttpError(404, 'Extração não encontrada ou expirada.');
  return job;
}

/** Extração em andamento (ou concluída e ainda disponível) do usuário, para retomar a tela após recarregar. */
function getCurrent(email) {
  const job = findJobOf(email, (j) => isActive(j) || j.status === 'done');
  return job ? toPublic(job) : null;
}

module.exports = { start, getJob, getCurrent, toPublic, normalizeTicketIds };
