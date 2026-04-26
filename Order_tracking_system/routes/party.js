const express = require('express');
const router = express.Router();
const pool = require('../db');

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  return next();
}
function ensureAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  return next();
}


// Page route
router.get('/master/party', ensureAuth, (req, res) => {
  if (req.session.user.role !== 'ADMIN') return res.status(403).send('Access denied. Admin only.');
  res.render('master/party', { user: req.session.user });
});

// GET parties by dealer_id
router.get('/api/party/by-dealer/:dealerId', ensureAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT party_id, party_code, party_name, party_company_name,
              party_address, party_phone, party_email, party_is_active_flag,
              dealer_id, created_at, updated_at
         FROM odts.dealer_party
        WHERE dealer_id = $1
        ORDER BY party_id`,
      [req.params.dealerId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET all parties
router.get('/api/party', ensureAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
              p.party_id,
              p.party_code,
              p.party_name,
              p.party_company_name,
              p.party_address,
              p.party_phone,
              p.party_email,
              p.party_is_active_flag,
              p.created_at,
              p.updated_at,
              d.dealer_id,
              d.dealer_code,
              d.dealer_name,
              d.dealer_company_name,
              d.dealer_phone   AS dealer_phone,
              d.dealer_email   AS dealer_email,
              d.dealer_address AS dealer_address,
              d.dealer_daily_limit,
              d.dealer_monthly_target
         FROM odts.dealer_party p
         LEFT JOIN odts.dealers d ON d.dealer_id = p.dealer_id
        ORDER BY p.party_id`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET dealers list for dropdown
router.get('/api/party/dealers-list', ensureAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT dealer_id, dealer_name FROM odts.dealers
        WHERE COALESCE(dealer_is_active_flag, TRUE) = TRUE
        ORDER BY dealer_name`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create
router.post('/api/party', ensureAdmin, async (req, res) => {
  const { dealer_id, party_code, party_company_name, party_name,
          party_address, party_phone, party_email, party_is_active_flag } = req.body;
  if (!party_company_name) return res.status(400).json({ error: 'Party company name is required' });
  try {
    const userId = req.session.user.id;
    if (!userId) return res.status(400).json({ error: 'User session invalid.' });
    // Auto-generate party_code if not provided
    const resolvedCode = (party_code || '').trim() ||
      (party_company_name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) + '_' + Date.now().toString().slice(-5));
    const r = await pool.query(
      `INSERT INTO odts.dealer_party
         (dealer_id, party_code, party_company_name, party_name,
          party_address, party_phone, party_email, party_is_active_flag,
          created_by, created_at, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,now())
       RETURNING *`,
      [
        dealer_id || null,
        resolvedCode,
        party_company_name.trim(),
        (party_name || '').trim() || null,
        (party_address || '').trim() || null,
        (party_phone || '').trim() || null,
        (party_email || '').trim() || null,
        party_is_active_flag !== false,
        userId, userId
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update
router.put('/api/party/:id', ensureAdmin, async (req, res) => {
  const { dealer_id, party_code, party_company_name, party_name,
          party_address, party_phone, party_email, party_is_active_flag } = req.body;
  if (!party_company_name) return res.status(400).json({ error: 'Party company name is required' });
  try {
    const userId = req.session.user.id;
    if (!userId) return res.status(400).json({ error: 'User session invalid.' });
    const r = await pool.query(
      `UPDATE odts.dealer_party
          SET dealer_id=$1, party_code=$2, party_company_name=$3, party_name=$4,
              party_address=$5, party_phone=$6, party_email=$7, party_is_active_flag=$8,
              updated_by=$9, updated_at=now()
        WHERE party_id=$10
        RETURNING *`,
      [
        dealer_id || null,
        (party_code || '').trim() || null,
        party_company_name.trim(),
        (party_name || '').trim() || null,
        (party_address || '').trim() || null,
        (party_phone || '').trim() || null,
        (party_email || '').trim() || null,
        party_is_active_flag !== false,
        userId,
        req.params.id
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Party not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
