// Último middleware: converte erros em respostas JSON { message }
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err);

  res.status(status).json({
    // Erros inesperados (sem status) não vazam detalhes internos; HttpError/JSON inválido sim
    message: status >= 500 && !err.status ? 'Erro interno do servidor.' : err.message,
  });
}

module.exports = errorHandler;
