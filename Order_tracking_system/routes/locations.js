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

router.get('/master/locations', ensureAuth, (req, res) => {
  if (req.session.user.role !== 'ADMIN') return res.status(403).send('Access denied. Admin only.');
  res.render('master/locations', { user: req.session.user });
});

router.get('/api/locations', ensureAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM odts.locations ORDER BY 1');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/locations', ensureAdmin, async (req, res) => {
  const { location_name, location_desc, location_is_active_flag } = req.body;
  if (!location_name) return res.status(400).json({ error: 'Location name required' });
  try {
    const r = await pool.query(
      `INSERT INTO odts.locations(location_name, location_desc, location_is_active_flag, created_at, updated_at)
       VALUES($1,$2,$3,now(),now()) RETURNING *`,
      [location_name.trim(), location_desc||'', location_is_active_flag !== false]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/locations/:id', ensureAdmin, async (req, res) => {
  const { location_name, location_desc, location_is_active_flag } = req.body;
  if (!location_name) return res.status(400).json({ error: 'Location name required' });
  try {
    const r = await pool.query(
      `UPDATE odts.locations SET location_name=$1, location_desc=$2, location_is_active_flag=$3, updated_at=now()
       WHERE location_id=$4 RETURNING *`,
      [location_name.trim(), location_desc||'', location_is_active_flag !== false, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
