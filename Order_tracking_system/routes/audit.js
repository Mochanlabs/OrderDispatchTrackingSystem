const express = require('express');
const router = express.Router();
const pool = require('../db');

function ensureAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden – Admin only');
}

// Common SELECT projection used in both active-sessions and login-report.
// For DEALER role → pull name/phone/email from dealers table.
// For all other roles → pull from users table.
const USER_INFO_SELECT = `
  a.login_audit_id                                              AS audit_id,
  a.login_user_id                                              AS user_id,
  CASE WHEN ur.role_name = 'DEALER'
       THEN d.dealer_name
       ELSE u.user_name
  END                                                          AS username,
  CASE WHEN ur.role_name = 'DEALER'
       THEN d.dealer_email
       ELSE u.user_email
  END                                                          AS email,
  CASE WHEN ur.role_name = 'DEALER'
       THEN d.dealer_phone
       ELSE u.user_phone
  END                                                          AS mobile,
  COALESCE(ur.role_name, 'UNKNOWN')                            AS role,
  u.user_login_name                                            AS login_name,
  CASE WHEN ur.role_name = 'DEALER' THEN d.dealer_code
       ELSE NULL END                                           AS dealer_code,
  CASE WHEN ur.role_name = 'DEALER' THEN d.dealer_company_name
       ELSE NULL END                                           AS dealer_company_name,
  a.login_method,
  a.login_status,
  a.login_at,
  a.logout_at,
  a.login_ip_address                                           AS ip_address,
  a.login_is_active
`;

const AUDIT_JOINS = `
  FROM odts.user_login_audit a
  LEFT JOIN odts.users       u  ON u.user_id      = a.login_user_id
  LEFT JOIN odts.user_roles  ur ON ur.role_id     = u.user_role_id
  LEFT JOIN odts.dealers     d  ON d.dealer_id    = u.dealer_id
`;

// ── Page ──────────────────────────────────────────────────────────────────────
router.get('/admin/sessions', ensureAdmin, (req, res) => {
  res.render('admin/sessions', { user: req.session.user });
});

// ── API: currently active sessions ───────────────────────────────────────────
router.get('/api/admin/active-sessions', ensureAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${USER_INFO_SELECT},
              EXTRACT(EPOCH FROM (NOW() - a.login_at))::int AS session_seconds
       ${AUDIT_JOINS}
       WHERE a.login_is_active = TRUE
       ORDER BY a.login_at DESC`
    );
    res.json({ success: true, rows: result.rows });
  } catch (e) {
    console.error('[Audit API] active-sessions error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── API: login history report (date range + optional role filter) ─────────────
router.get('/api/admin/login-report', ensureAdmin, async (req, res) => {
  try {
    const { from, to, role, status } = req.query;
    const fromDate = from || new Date().toISOString().slice(0, 10);
    const toDate   = to   || new Date().toISOString().slice(0, 10);

    const conditions = [
      `a.login_at >= $1::date`,
      `a.login_at <  ($2::date + interval '1 day')`
    ];
    const params = [fromDate, toDate];
    let idx = 3;

    if (role && role !== 'ALL') {
      conditions.push(`ur.role_name = $${idx++}`);
      params.push(role);
    }
    if (status && status !== 'ALL') {
      conditions.push(`a.login_status = $${idx++}`);
      params.push(status);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      SELECT ${USER_INFO_SELECT},
             CASE WHEN a.logout_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (a.logout_at - a.login_at))::int
                  ELSE NULL
             END AS session_seconds
      ${AUDIT_JOINS}
      ${where}
      ORDER BY a.login_at DESC`;

    const result = await pool.query(sql, params);
    res.json({ success: true, rows: result.rows });
  } catch (e) {
    console.error('[Audit API] login-report error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── API: available roles for filter dropdown ──────────────────────────────────
router.get('/api/admin/audit-roles', ensureAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ur.role_name AS role
         FROM odts.user_login_audit a
         LEFT JOIN odts.users      u  ON u.user_id  = a.login_user_id
         LEFT JOIN odts.user_roles ur ON ur.role_id = u.user_role_id
        WHERE ur.role_name IS NOT NULL
        ORDER BY ur.role_name`
    );
    res.json({ success: true, roles: result.rows.map(r => r.role) });
  } catch (e) {
    res.json({ success: true, roles: [] });
  }
});

module.exports = router;
