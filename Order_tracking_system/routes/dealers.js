const express = require('express');
const router = express.Router();
const pool = require('../db');

async function hasColumn(tableName, columnName) {
  const r = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'odts'
        AND table_name = $1
        AND column_name = $2`,
    [tableName, columnName]
  );
  return r.rows.length > 0;
}

async function getFirstExistingColumn(tableName, candidates) {
  for (const c of candidates) {
    if (await hasColumn(tableName, c)) return c;
  }
  return null;
}

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  return next();
}
function ensureAdminOrOffice(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const role = req.session.user.role;
  if (role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE') return res.status(403).json({ error: 'Access denied' });
  return next();
}
function ensureAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  return next();
}

router.get('/master/dealers', ensureAuth, (req, res) => {
  const role = req.session.user.role;
  if (role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE') return res.status(403).send('Access denied.');
  res.render('master/dealers', { user: req.session.user });
});

router.get('/api/dealers', ensureAdminOrOffice, async (req, res) => {
  try {
    const dealerCompanyCol = await getFirstExistingColumn('dealers', ['dealer_company_name', 'dealer_company']);
    const hasDealerEmail = await hasColumn('dealers', 'dealer_email');
    const hasLocationId = await hasColumn('dealers', 'location_id');
    const r = await pool.query(
      `SELECT dealer_id,
              dealer_name,
              ${dealerCompanyCol ? `d.${dealerCompanyCol} AS dealer_company_name` : 'dealer_name AS dealer_company_name'},
              dealer_code,
              dealer_phone,
              ${hasDealerEmail ? 'dealer_email' : 'NULL::varchar AS dealer_email'},
              ${hasLocationId ? 'location_id' : 'NULL::int AS location_id'},
              ${hasLocationId ? 'l.location_name' : 'NULL::varchar AS location_name'},
              dealer_address,
              dealer_daily_limit, dealer_monthly_target,
              dealer_is_active_flag, created_at, updated_at
       FROM odts.dealers d
       ${hasLocationId ? 'LEFT JOIN odts.locations l ON l.location_id = d.location_id' : ''}
       ORDER BY dealer_id`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/dealers/locations', ensureAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT location_id, location_name
         FROM odts.locations
        WHERE COALESCE(location_is_active_flag, TRUE) = TRUE
        ORDER BY location_name`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/dealers', ensureAdmin, async (req, res) => {
  const { dealer_name, dealer_company_name, dealer_code, dealer_phone, dealer_email, location_id, dealer_address,
          dealer_is_active_flag, dealer_daily_limit, dealer_monthly_target } = req.body;
  if (!dealer_name) return res.status(400).json({ error: 'Dealer name required' });
  try {
    const dealerCompanyCol = await getFirstExistingColumn('dealers', ['dealer_company_name', 'dealer_company']);
    const hasDealerEmail = await hasColumn('dealers', 'dealer_email');
    const hasLocationId = await hasColumn('dealers', 'location_id');
    const cols = ['dealer_name'];
    const values = [dealer_name.trim()];
    const placeholders = ['$1'];
    let i = 2;

    if (dealerCompanyCol) {
      cols.push(dealerCompanyCol);
      values.push((dealer_company_name || '').trim() || null);
      placeholders.push(`$${i++}`);
    }

    if (hasDealerEmail) {
      cols.push('dealer_email');
      values.push((dealer_email || '').trim() || null);
      placeholders.push(`$${i++}`);
    }

    if (hasLocationId) {
      cols.push('location_id');
      values.push(location_id ? Number(location_id) : null);
      placeholders.push(`$${i++}`);
    }

    cols.push('dealer_code', 'dealer_phone', 'dealer_address', 'dealer_is_active_flag', 'dealer_daily_limit', 'dealer_monthly_target', 'created_at', 'updated_at');
    values.push(dealer_code||'', dealer_phone||'', dealer_address||'', dealer_is_active_flag !== false, dealer_daily_limit||0, dealer_monthly_target||0);
    placeholders.push(`$${i++}`, `$${i++}`, `$${i++}`, `$${i++}`, `$${i++}`, `$${i++}`, 'now()', 'now()');

    const r = await pool.query(
      `INSERT INTO odts.dealers (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/dealers/:id', ensureAdmin, async (req, res) => {
  const { dealer_name, dealer_company_name, dealer_code, dealer_phone, dealer_email, location_id, dealer_address,
          dealer_is_active_flag, dealer_daily_limit, dealer_monthly_target } = req.body;
  if (!dealer_name) return res.status(400).json({ error: 'Dealer name required' });
  try {
    const dealerCompanyCol = await getFirstExistingColumn('dealers', ['dealer_company_name', 'dealer_company']);
    const hasDealerEmail = await hasColumn('dealers', 'dealer_email');
    const hasLocationId = await hasColumn('dealers', 'location_id');
    const setParts = ['dealer_name=$1'];
    const values = [dealer_name.trim()];
    let i = 2;

    if (dealerCompanyCol) {
      setParts.push(`${dealerCompanyCol}=$${i++}`);
      values.push((dealer_company_name || '').trim() || null);
    }

    if (hasDealerEmail) {
      setParts.push(`dealer_email=$${i++}`);
      values.push((dealer_email || '').trim() || null);
    }

    if (hasLocationId) {
      setParts.push(`location_id=$${i++}`);
      values.push(location_id ? Number(location_id) : null);
    }

    setParts.push(`dealer_code=$${i++}`); values.push(dealer_code||'');
    setParts.push(`dealer_phone=$${i++}`); values.push(dealer_phone||'');
    setParts.push(`dealer_address=$${i++}`); values.push(dealer_address||'');
    setParts.push(`dealer_is_active_flag=$${i++}`); values.push(dealer_is_active_flag !== false);
    setParts.push(`dealer_daily_limit=$${i++}`); values.push(dealer_daily_limit||0);
    setParts.push(`dealer_monthly_target=$${i++}`); values.push(dealer_monthly_target||0);
    setParts.push('updated_at=now()');
    values.push(req.params.id);

    const r = await pool.query(
      `UPDATE odts.dealers
          SET ${setParts.join(', ')}
        WHERE dealer_id=$${i} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/dealers/bulk-limits', ensureAdmin, async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0)
    return res.status(400).json({ error: 'No updates provided' });
  try {
    let updated = 0;
    for (const u of updates) {
      if (!u.dealer_id) continue;
      const r = await pool.query(
        `UPDATE odts.dealers
            SET dealer_daily_limit=$1, dealer_monthly_target=$2, updated_at=now()
          WHERE dealer_id=$3`,
        [
          parseFloat(u.dealer_daily_limit) || 0,
          parseFloat(u.dealer_monthly_target) || 0,
          u.dealer_id
        ]
      );
      if (r.rowCount > 0) updated++;
    }
    res.json({ updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
