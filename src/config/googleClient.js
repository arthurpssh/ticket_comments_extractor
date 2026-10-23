const { google } = require('googleapis');

if (!process.env.GOOGLE_CLIENT_EMAIL) throw new Error('GOOGLE_CLIENT_EMAIL environment variable is required');
if (!process.env.GOOGLE_PRIVATE_KEY) throw new Error('GOOGLE_PRIVATE_KEY environment variable is required');

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  // Esta aplicação só lê/grava planilhas (não usa o Drive)
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Retorna a instância já autenticada do Sheets
async function getSheetsClient() {
  try {
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  } catch (error) {
    console.error('Erro ao inicializar o cliente do Google Sheets:', error);
    throw error;
  }
}

module.exports = { getSheetsClient };
