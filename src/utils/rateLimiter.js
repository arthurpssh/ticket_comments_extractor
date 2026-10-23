// Limitador global de pedidos ao Zendesk (todas as extrações compartilham o mesmo).
//
//  - Espaça os pedidos: no máximo `maxRpm` por minuto (fila FIFO).
//  - pause(ms): coloca todo mundo em espera (429 / Retry-After).
//  - observe(headers): se o restante do limite do Zendesk (X-Rate-Limit-Remaining) cair abaixo de
//    `guardRatio` do total, outros consumidores estão usando muito: pausa até a janela reiniciar.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RateLimiter {
  constructor({ maxRpm, guardRatio = 0.5, now = Date.now, wait = sleep }) {
    this.intervalMs = 60000 / maxRpm;
    this.guardRatio = guardRatio;
    this.now = now;
    this.wait = wait;
    this.nextSlot = 0; // quando o próximo pedido pode sair
    this.pausedUntil = 0;
  }

  /** Resolve quando este pedido pode ser feito. */
  async acquire() {
    const now = this.now();
    const slot = Math.max(this.nextSlot, this.pausedUntil, now);
    this.nextSlot = slot + this.intervalMs;
    const delay = slot - now;
    if (delay > 0) await this.wait(delay);

    // Uma pausa pode ter sido pedida enquanto este pedido esperava na fila
    const stillPaused = this.pausedUntil - this.now();
    if (stillPaused > 0) {
      this.nextSlot = Math.max(this.nextSlot, this.pausedUntil + this.intervalMs);
      await this.wait(stillPaused);
    }
  }

  pause(ms) {
    if (ms > 0) this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** Lê os cabeçalhos de rate limit da resposta do Zendesk. Retorna true se acionou o freio. */
  observe(headers) {
    if (!headers || typeof headers.get !== 'function') return false;
    const remaining = Number(headers.get('x-rate-limit-remaining'));
    const limit = Number(headers.get('x-rate-limit'));
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return false;

    if (remaining < limit * this.guardRatio) {
      const resetSeconds = Number(headers.get('ratelimit-reset'));
      this.pause((Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds : 10) * 1000);
      return true;
    }
    return false;
  }
}

module.exports = { RateLimiter };
