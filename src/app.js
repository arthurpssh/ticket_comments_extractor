// src/app.js
const express = require('express');
const path = require('path');

const { requireUser, requireAdmin } = require('./middlewares/auth');
const errorHandler = require('./middlewares/errorHandler');
const apiRoutes = require('./routes/apiRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' })); // até 1000 IDs de ticket

// Health check: instantâneo, sem autenticação e sem tocar no Sheets/Zendesk (NUNCA remover)
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

// A partir daqui: usuário autenticado pelo ingress (X-Auth-Request-Email)
app.use(requireUser);

// Chart.js servido localmente (versão fixada pelo package-lock.json), usado só pela página de admin
app.use('/vendor/chartjs', express.static(path.join(__dirname, '../node_modules/chart.js/dist'), { index: false, redirect: false }));

// Arquivos estáticos (CSS, JS). index/redirect desligados: as páginas são servidas por rotas.
app.use(express.static(path.join(__dirname, '../public'), { index: false, redirect: false }));

app.use('/api/admin', requireAdmin, adminRoutes);
app.use('/api', apiRoutes);
app.use('/api', (req, res) => res.status(404).json({ message: 'Rota não encontrada.' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// A página de admin fica fora de public/ (servido a qualquer usuário autenticado)
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));

app.use(errorHandler);

module.exports = app;
