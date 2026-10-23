const path = require('path');
const config = require('../config/extraction');
const usageService = require('../services/usageService');
const { sheetsFailure } = require('../utils/sheetsError');

const VIEWS = path.join(__dirname, '../views');
// originalUrl (não path): dentro de routers montados o path perde o prefixo
const isApi = (req) => req.originalUrl.startsWith('/api/');

function forbidden(req, res, message) {
  if (isApi(req)) return res.status(403).json({ message });
  return res.status(403).sendFile(path.join(VIEWS, '403.html'));
}

/**
 * Autenticação: o ingress da plataforma (auth-url do values.yml) autentica o usuário e injeta o
 * e-mail em X-Auth-Request-Email. A autorização de uso (saldo de tickets) fica em services/usageService.js.
 */
function requireUser(req, res, next) {
  const email = String(req.get('x-auth-request-email') || config.devUserEmail || '')
    .trim()
    .toLowerCase();

  if (!email) return forbidden(req, res, 'Não foi possível identificar o usuário.');

  req.user = { email };
  return next();
}

/** Autorização das rotas de admin: role "admin" na aba "Use Controller". */
async function requireAdmin(req, res, next) {
  let admin;
  try {
    admin = await usageService.isAdmin(req.user.email);
  } catch (error) {
    throw sheetsFailure(error);
  }
  if (!admin) return forbidden(req, res, 'Acesso negado. Esta área é restrita a administradores.');
  return next();
}

module.exports = { requireUser, requireAdmin };
