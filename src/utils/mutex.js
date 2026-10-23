// Exclusão mútua do ciclo ler -> alterar -> gravar nas abas de controle, dentro deste processo
// (a aplicação roda com 1 réplica). Todas as escritas de cota/config passam por aqui.
let queue = Promise.resolve();

function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

module.exports = { withLock };
