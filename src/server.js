// src/server.js
require('dotenv').config(); // Carrega as variáveis do arquivo .env (apenas desenvolvimento local)
const app = require('./app');

// O Magic Deploy (e outros PaaS) injeta a porta na variável process.env.PORT
const PORT = process.env.PORT || 3001;

// '0.0.0.0' garante que o app aceite conexões externas no container
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
