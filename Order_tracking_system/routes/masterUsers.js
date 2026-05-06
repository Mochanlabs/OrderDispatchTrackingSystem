const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');

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

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

async function fetchLoginUsersRows() {
  const hasDealerCompanyName = await hasColumn('dealers', 'dealer_company_name');
  const hasDealerEmail = await hasColumn('dealers', 'dealer_email');

  return pool.query(`
    SELECT
      u.user_id,
      u.user_login_name,
      u.user_name,
      u.user_email,
      u.user_phone,
      u.user_role_id,
      u.dealer_id,
      COALESCE(u.user_is_active_flag, TRUE)  AS user_is_active_flag,
      COALESCE(u.user_is_locked_flag, FALSE) AS user_is_locked_flag,
      u.created_at,
      u.updated_at,
      r.role_name,
      r.role_id,
      CASE WHEN UPPER(COALESCE(r.role_name, '')) = 'DEALER' THEN TRUE ELSE FALSE END AS is_dealer_role,
      ${hasDealerCompanyName ? 'd.dealer_company_name' : 'd.dealer_name AS dealer_company_name'},
      d.dealer_name,
      d.dealer_phone,
      ${hasDealerEmail ? 'd.dealer_email' : 'NULL::varchar AS dealer_email'},
      CASE
        WHEN UPPER(COALESCE(r.role_name, '')) = 'DEALER' THEN COALESCE(${hasDealerEmail ? 'd.dealer_email' : 'NULL::varchar'}, u.user_email)
        ELSE u.user_email
      END AS display_email,
      CASE
        WHEN UPPER(COALESCE(r.role_name, '')) = 'DEALER' THEN COALESCE(d.dealer_phone, u.user_phone)
        ELSE u.user_phone
      END AS display_phone,
      CASE
        WHEN UPPER(COALESCE(r.role_name, '')) = 'DEALER' THEN COALESCE(d.dealer_name, u.user_name)
        ELSE u.user_name
      END AS display_name,
      CASE
        WHEN UPPER(COALESCE(r.role_name, '')) = 'DEALER' THEN COALESCE(${hasDealerCompanyName ? 'd.dealer_company_name' : 'd.dealer_name'})
        ELSE NULL::varchar
      END AS display_dealer_company_name
    FROM odts.users u
    LEFT JOIN odts.user_roles r ON u.user_role_id = r.role_id
    LEFT JOIN odts.dealers d ON u.dealer_id = d.dealer_id
    ORDER BY u.user_id
  `);
}

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  return next();
}
function ensureAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  return next();
}

router.get('/master/users', ensureAuth, (req, res) => {
  if (req.session.user.role !== 'ADMIN') return res.status(403).send('Access denied. Admin only.');
  res.render('master/users', { user: req.session.user });
});

router.get('/api/master/users', ensureAdmin, async (req, res) => {
  try {
    noStore(res);
    const r = await fetchLoginUsersRows();
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/master/users/roles', ensureAdmin, async (req, res) => {
  try {
    noStore(res);
    const r = await pool.query('SELECT role_id, role_name FROM odts.user_roles ORDER BY role_name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/master/users', ensureAdmin, async (req, res) => {
  const { user_name, user_login_name, user_email, user_phone, role_id, user_is_active_flag, user_is_locked_flag, password } = req.body;
  if (!user_name || !user_login_name || !user_email) return res.status(400).json({ error: 'Name, user name and email are required' });
  try {
    const actorId = req.session?.user?.id || 0;
    const existing = await pool.query('SELECT user_id FROM odts.users WHERE user_email=$1', [user_email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already exists' });
    const existingLogin = await pool.query('SELECT user_id FROM odts.users WHERE user_login_name=$1', [user_login_name]);
    if (existingLogin.rows.length) return res.status(400).json({ error: 'User name already exists' });
    const hash = await bcrypt.hash(password || 'Change@123', 10);
    const r = await pool.query(
      `INSERT INTO odts.users(user_name, user_login_name, user_email, user_phone, password_hash, user_role_id, user_is_active_flag, user_is_locked_flag, created_by, updated_by, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
       RETURNING user_id, user_name, user_login_name, user_email, user_phone, user_is_active_flag, user_is_locked_flag, created_at`,
      [
        user_name.trim(),
        user_login_name.trim(),
        user_email.trim(),
        user_phone || '',
        hash,
        role_id || null,
        user_is_active_flag !== false,
        user_is_locked_flag === true,
        actorId,
        actorId,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/master/users/:id', ensureAdmin, async (req, res) => {
  const { user_name, user_login_name, user_email, user_phone, role_id, user_is_active_flag, user_is_locked_flag, password } = req.body;
  if (!user_name || !user_login_name) return res.status(400).json({ error: 'Name and user name are required' });
  try {
    const actorId = req.session?.user?.id || 0;
    const cleanName = String(user_name || '').trim();
    const cleanLoginName = String(user_login_name || '').trim();
    const existingLogin = await pool.query('SELECT user_id FROM odts.users WHERE user_login_name=$1 AND user_id<>$2', [cleanLoginName, req.params.id]);
    if (existingLogin.rows.length) return res.status(400).json({ error: 'User name already exists' });

    const cleanEmail = String(user_email || '').trim();
    const cleanPhone = String(user_phone || '').trim();
    if (cleanEmail) {
      const existingEmail = await pool.query('SELECT user_id FROM odts.users WHERE user_email=$1 AND user_id<>$2', [cleanEmail, req.params.id]);
      if (existingEmail.rows.length) return res.status(400).json({ error: 'Email already exists' });
    }

    const userRes = await pool.query(
      'SELECT user_id, dealer_id, user_role_id, user_email, user_phone FROM odts.users WHERE user_id=$1',
      [req.params.id]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const existingUser = userRes.rows[0];

    const effectiveRoleId = role_id || existingUser.user_role_id || null;
    const effectiveEmail = cleanEmail !== '' ? cleanEmail : (existingUser.user_email || '');
    const effectivePhone = cleanPhone !== '' ? cleanPhone : (existingUser.user_phone || '');

    const roleRes = await pool.query('SELECT role_name FROM odts.user_roles WHERE role_id=$1', [effectiveRoleId]);
    const roleName = roleRes.rows[0]?.role_name || '';
    const isDealerRole = String(roleName).toUpperCase() === 'DEALER';

    if (isDealerRole && existingUser.dealer_id) {
      const dealerId = existingUser.dealer_id;
      const setParts = [];
      const values = [];
      let di = 1;

      if (await hasColumn('dealers', 'dealer_company_name')) {
        setParts.push(`dealer_company_name=$${di++}`);
        values.push(cleanName);
      }
      if (await hasColumn('dealers', 'dealer_name')) {
        setParts.push(`dealer_name=$${di++}`);
        values.push(cleanName);
      }
      if (await hasColumn('dealers', 'dealer_phone')) {
        setParts.push(`dealer_phone=$${di++}`);
        values.push(effectivePhone || null);
      }
      if (await hasColumn('dealers', 'dealer_email')) {
        setParts.push(`dealer_email=$${di++}`);
        values.push(effectiveEmail || null);
      }
      if (await hasColumn('dealers', 'updated_at')) setParts.push('updated_at=now()');

      if (setParts.length) {
        values.push(dealerId);
        await pool.query(`UPDATE odts.dealers SET ${setParts.join(', ')} WHERE dealer_id=$${di}`, values);
      }
    }

    let query, params;
    if (password && password.trim()) {
      const hash = await bcrypt.hash(password, 10);
      query = `UPDATE odts.users
               SET user_name=$1, user_login_name=$2, user_email=$3, user_phone=$4, user_role_id=$5,
                   user_is_active_flag=$6, user_is_locked_flag=$7, password_hash=$8, updated_by=$9, updated_at=now()
               WHERE user_id=$10
               RETURNING user_id, user_name, user_login_name, user_email, user_phone, user_is_active_flag, user_is_locked_flag, updated_at`;
      params = [cleanName, cleanLoginName, effectiveEmail, effectivePhone, effectiveRoleId, user_is_active_flag !== false, user_is_locked_flag === true, hash, actorId, req.params.id];
    } else {
      query = `UPDATE odts.users
               SET user_name=$1, user_login_name=$2, user_email=$3, user_phone=$4, user_role_id=$5,
                   user_is_active_flag=$6, user_is_locked_flag=$7, updated_by=$8, updated_at=now()
               WHERE user_id=$9
               RETURNING user_id, user_name, user_login_name, user_email, user_phone, user_is_active_flag, user_is_locked_flag, updated_at`;
      params = [cleanName, cleanLoginName, effectiveEmail, effectivePhone, effectiveRoleId, user_is_active_flag !== false, user_is_locked_flag === true, actorId, req.params.id];
    }
    const r = await pool.query(query, params);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
