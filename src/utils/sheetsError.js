const { HttpError } = require('./errors');

// Falhas do Google Sheets são de infraestrutura: mensagem clara, sem parecer um 403 de usuário
function sheetsFailure(error) {
  if (error && error.status) return error; // já é HttpError
  console.error('[sheets] erro:', error);
  const reason = error && error.code === 403 ? ' (a service account precisa ser Editora da planilha de controle)' : '';
  return new HttpError(502, `Falha ao acessar a planilha de controle${reason}.`);
}

module.exports = { sheetsFailure };
