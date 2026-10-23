const express = require('express');
const adminService = require('../services/adminService');
const { sheetsFailure } = require('../utils/sheetsError');

// Rotas de admin (o middleware requireAdmin é aplicado em app.js, antes deste router)
const router = express.Router();

// Falhas do Sheets viram erro de infraestrutura com mensagem clara
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    throw sheetsFailure(error);
  }
};

router.get(
  '/bootstrap',
  wrap(async (req) => ({
    email: req.user.email,
    config: await adminService.getConfig(),
    users: await adminService.listUsers(),
  }))
);

router.put('/config', wrap((req) => adminService.setConfig(req.body || {})));

router.get('/users', wrap(() => adminService.listUsers()));
router.post('/users', wrap((req) => adminService.addUsers(req.body && req.body.raw)));
router.patch('/users', wrap((req) => adminService.updateUser(req.user.email, req.body || {})));
router.delete('/users', wrap((req) => adminService.deleteUser(req.user.email, req.query.user)));

router.get('/analytics', wrap((req) => adminService.getAnalytics(req.query)));
router.get('/ledger', wrap((req) => adminService.getLedger(req.query)));

module.exports = router;
