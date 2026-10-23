const express = require('express');
const usageService = require('../services/usageService');
const extractionService = require('../services/extractionService');
const { HttpError } = require('../utils/errors');
const { sheetsFailure } = require('../utils/sheetsError');

const router = express.Router();

router.get('/me', (req, res) => res.json({ email: req.user.email }));

router.get('/usage', async (req, res) => {
  try {
    res.json(await usageService.getUsageStatus(req.user.email));
  } catch (error) {
    throw sheetsFailure(error);
  }
});

// E-mails cadastrados, para escolher o destinatário de uma doação de tickets
router.get('/users', async (req, res) => {
  try {
    const emails = await usageService.listRegisteredEmails();
    res.json(emails.filter((e) => e.toLowerCase() !== req.user.email));
  } catch (error) {
    throw sheetsFailure(error);
  }
});

// O usuário doa parte do próprio saldo do dia para outro usuário
router.post('/transfers', async (req, res) => {
  try {
    const { to, amount } = req.body || {};
    if (typeof to !== 'string' || to.trim() === '') throw new HttpError(400, 'Informe o destinatário.');
    res.json(await usageService.transfer(req.user.email, to.trim(), amount));
  } catch (error) {
    throw sheetsFailure(error);
  }
});

// Inicia uma extração (consome os tickets da cota) e responde na hora; o andamento é consultado por polling
router.post('/extractions', async (req, res) => {
  try {
    const job = await extractionService.start(req.user.email, req.body && req.body.tickets);
    res.status(202).json(job);
  } catch (error) {
    throw sheetsFailure(error);
  }
});

router.get('/extractions/current', (req, res) => {
  res.json(extractionService.getCurrent(req.user.email));
});

router.get('/extractions/:id', (req, res) => {
  res.json(extractionService.toPublic(extractionService.getJob(req.user.email, req.params.id)));
});

router.get('/extractions/:id/download', (req, res) => {
  const job = extractionService.getJob(req.user.email, req.params.id);
  if (job.status !== 'done' || !job.file) throw new HttpError(409, 'O arquivo ainda não está disponível.');

  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${job.filename}"`,
    'Content-Length': job.file.length,
    'Cache-Control': 'no-store',
  });
  res.send(job.file);
});

module.exports = router;
