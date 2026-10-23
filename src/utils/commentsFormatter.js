// Formatação dos comentários de um ticket em texto corrido (portado do formatComments do Apps Script).

const TIME_ZONE = 'America/Sao_Paulo'; // o container roda em UTC; o Apps Script usava este fuso

// Oculta CPF/CNPJ no texto
function redactSensitive(str) {
  if (typeof str !== 'string') return '';
  const cpfOuCnpjRegex = /\b(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{3}\s\d{3}\s\d{3}\s\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{11}|\d{14})\b/g;
  return str.replace(cpfOuCnpjRegex, '{REDACTED}');
}

function getUserRole(user) {
  if (!user) return 'Sistema';
  if (user.role === 'agent') return 'Agente';
  if (user.role === 'admin') return 'Admin';
  return 'Cliente';
}

function formatTime(isoDate) {
  // O ICU do Node insere uma vírgula entre data e hora ("08/10/2026, 22:00:00"); o Apps Script não
  return new Date(isoDate).toLocaleString('pt-BR', { timeZone: TIME_ZONE }).replace(', ', ' ');
}

/**
 * @param {object[]} comments - comentários do Zendesk
 * @param {object[]} users - usuários referenciados (include=users)
 * @returns {string} comentários em ordem cronológica separados por linha em branco
 */
function formatComments(comments, users) {
  const usersById = new Map(users.map((u) => [String(u.id), u]));

  return [...comments]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((comment) => {
      const user = usersById.get(String(comment.author_id));
      const role = getUserRole(user);
      // O e-mail do autor não é exposto no arquivo; autor desconhecido aparece como "System"
      const author = user ? '{REDACTED}' : 'System';
      const message = redactSensitive(String(comment.body || '').replace(/\\n/g, '\n'));
      const visibility = comment.public ? 'Mensagem pública' : 'Observação interna';

      const header = `${formatTime(comment.created_at)} - [${role}] ${author} (${visibility}): `;
      return `${header}${message}\n\n----------------------------------------`;
    })
    .join('\n\n');
}

module.exports = { formatComments, redactSensitive, getUserRole };
