const express = require('express');
const router = express.Router();
const userModel = require('../models/userModel');
const pool = require('../db');
const failedPasswordAttemptsGlobal = new Map();
let hasUserIsLockedFlagColumnCache = null;
const auditColumnCache = new Map();

// ── Audit helpers ────────────────────────────────────────────────────────────
async function getAuditColumn(candidates) {
  const key = candidates.join('|');
  if (auditColumnCache.has(key)) return auditColumnCache.get(key);

  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'odts'
        AND table_name = 'user_login_audit'
        AND column_name = ANY($1::text[])
      ORDER BY array_position($1::text[], column_name)
      LIMIT 1`,
    [candidates]
  );

  const col = r.rows[0]?.column_name || null;
  auditColumnCache.set(key, col);
  return col;
}

async function insertAudit(req, user, method, status) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null;
    const ua = (req.headers['user-agent'] || '').substring(0, 500) || null;
    const sid = req.session ? req.session.id : null;

    const userIdCol = await getAuditColumn(['login_user_id', 'user_id']);
    const usernameCol = await getAuditColumn(['login_username', 'username']);
    const emailCol = await getAuditColumn(['login_email', 'email']);
    const mobileCol = await getAuditColumn(['login_mobile', 'mobile']);
    const roleCol = await getAuditColumn(['login_role', 'role']);
    const methodCol = await getAuditColumn(['login_method']);
    const statusCol = await getAuditColumn(['login_status']);
    const loginAtCol = await getAuditColumn(['login_at']);
    const ipCol = await getAuditColumn(['login_ip_address', 'ip_address']);
    const userAgentCol = await getAuditColumn(['login_user_agent', 'user_agent']);
    const sessionCol = await getAuditColumn(['login_session_id', 'session_id']);
    const activeCol = await getAuditColumn(['login_is_active', 'is_active']);
    const auditIdCol = await getAuditColumn(['audit_id', 'login_audit_id']);

    const cols = [];
    const vals = [];
    const placeholders = [];
    let i = 1;
    const add = (col, val) => {
      if (!col) return;
      cols.push(col);
      vals.push(val);
      placeholders.push(`$${i++}`);
    };

    add(userIdCol, user.id || null);
    add(usernameCol, user.username || null);
    add(emailCol, user.email || null);
    add(mobileCol, user.mobile || null);
    add(roleCol, user.role || null);
    add(methodCol, method || 'PASSWORD');
    add(statusCol, status || 'SUCCESS');
    add(ipCol, ip);
    add(userAgentCol, ua);
    add(sessionCol, sid);
    add(activeCol, String(status || '').toUpperCase() === 'SUCCESS');

    if (loginAtCol) {
      cols.push(loginAtCol);
      placeholders.push('NOW()');
    }

    if (!cols.length) return null;

    const returning = auditIdCol ? ` RETURNING ${auditIdCol} AS audit_id` : '';
    const result = await pool.query(
      `INSERT INTO odts.user_login_audit (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})${returning}`,
      vals
    );

    return result.rows[0]?.audit_id || null;
  } catch (e) {
    console.error('[Audit] insert error:', e.message);
    return null;
  }
}

async function markLogout({ sessionId = null, userId = null, auditId = null } = {}) {
  try {
    const logoutAtCol = await getAuditColumn(['logout_at', 'login_logout_at']);
    const activeCol = await getAuditColumn(['login_is_active', 'is_active']);
    const sessionCol = await getAuditColumn(['login_session_id', 'session_id']);
    const userIdCol = await getAuditColumn(['login_user_id', 'user_id']);
    const auditIdCol = await getAuditColumn(['audit_id', 'login_audit_id']);

    const setParts = [];
    if (logoutAtCol) setParts.push(`${logoutAtCol} = NOW()`);
    if (activeCol) setParts.push(`${activeCol} = FALSE`);
    if (!setParts.length) return;

    const whereParts = [];
    const vals = [];
    let i = 1;

    if (auditId && auditIdCol) {
      whereParts.push(`${auditIdCol} = $${i++}`);
      vals.push(auditId);
    } else if (sessionId && sessionCol) {
      whereParts.push(`${sessionCol} = $${i++}`);
      vals.push(sessionId);
    } else if (userId && userIdCol) {
      whereParts.push(`${userIdCol} = $${i++}`);
      vals.push(userId);
    }

    if (!whereParts.length) return;
    if (activeCol) whereParts.push(`${activeCol} = TRUE`);

    await pool.query(
      `UPDATE odts.user_login_audit
          SET ${setParts.join(', ')}
        WHERE ${whereParts.join(' AND ')}`,
      vals
    );
  } catch (e) {
    console.error('[Audit] logout error:', e.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Simple OTP generation for demo: store OTP in session. In production use secure storage and SMS gateway.
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function hasTableColumn(tableName, columnName) {
  const result = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'odts'
        AND table_name = $1
        AND column_name = $2`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

async function fetchSignupScreenData() {
  const rolesRes = await pool.query(
    `SELECT role_id, role_name
       FROM odts.user_roles
      ORDER BY role_name`
  );

  const hasDealerCompanyName = await hasTableColumn('dealers', 'dealer_company_name');
  const hasDealerActiveFlag = await hasTableColumn('dealers', 'dealer_is_active_flag');

  const dealersRes = await pool.query(
    `SELECT dealer_id,
            dealer_name,
            dealer_code,
            ${hasDealerCompanyName ? 'dealer_company_name' : 'dealer_name AS dealer_company_name'}
       FROM odts.dealers
      ${hasDealerActiveFlag ? 'WHERE COALESCE(dealer_is_active_flag, TRUE) = TRUE' : ''}
      ORDER BY dealer_name`
  );

  const usersRes = await pool.query(
    `SELECT u.user_id,
            u.user_role_id,
            u.dealer_id,
            u.user_login_name,
            u.user_name,
        ${hasDealerCompanyName ? 'd.dealer_company_name' : 'd.dealer_name AS dealer_company_name'},
        d.dealer_name,
            COALESCE(u.user_is_active_flag, TRUE)  AS user_is_active_flag,
            COALESCE(u.user_is_locked_flag, FALSE) AS user_is_locked_flag,
            r.role_name
       FROM odts.users u
       LEFT JOIN odts.user_roles r ON r.role_id = u.user_role_id
      LEFT JOIN odts.dealers d ON d.dealer_id = u.dealer_id
      ORDER BY u.user_role_id, u.dealer_id, u.user_login_name`
  );

  return {
    roles: rolesRes.rows,
    dealers: dealersRes.rows,
    existingUsers: usersRes.rows,
  };
}

async function renderSignup(req, res, { error = null, success = null, formData = {} } = {}) {
  const data = await fetchSignupScreenData();
  return res.render('signup', {
    error,
    success,
    roles: data.roles,
    dealers: data.dealers,
    existingUsers: data.existingUsers,
    formData,
    user: req.session && req.session.user ? req.session.user : null,
  });
}

function ensureAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/signin');
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === role) return next();
    return res.status(403).send('Forbidden');
  };
}

function isAdminOrOfficeExecutiveRole(roleValue) {
  const normalized = String(roleValue || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return normalized === 'ADMIN' || normalized === 'OFFICE_EXECUTIVE';
}

function ensureAdminOrOfficeExecutive(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  if (isAdminOrOfficeExecutiveRole(req.session.user.role)) return next();
  return res.status(403).send('Access denied. Admin or Office Executive only.');
}

function getFailedAttemptStore(req) {
  if (!req.session) return {};
  if (!req.session.failedPasswordAttempts) req.session.failedPasswordAttempts = {};
  return req.session.failedPasswordAttempts;
}

function incrementFailedAttempt(req, loginName) {
  const key = String(loginName || '').trim().toLowerCase();
  if (!key) return 0;
  const store = getFailedAttemptStore(req);
  store[key] = (store[key] || 0) + 1;
  return store[key];
}

function clearFailedAttempt(req, loginName) {
  const key = String(loginName || '').trim().toLowerCase();
  if (!key || !req.session || !req.session.failedPasswordAttempts) return;
  delete req.session.failedPasswordAttempts[key];
}

function getFailedAttemptKey(userId, loginName) {
  if (userId) return `id:${userId}`;
  const normalizedLogin = String(loginName || '').trim().toLowerCase();
  return normalizedLogin ? `login:${normalizedLogin}` : '';
}

function incrementGlobalFailedAttempt(userId, loginName) {
  const key = getFailedAttemptKey(userId, loginName);
  if (!key) return 0;
  const next = (failedPasswordAttemptsGlobal.get(key) || 0) + 1;
  failedPasswordAttemptsGlobal.set(key, next);
  return next;
}

function clearGlobalFailedAttempt(userId, loginName) {
  const key = getFailedAttemptKey(userId, loginName);
  if (!key) return;
  failedPasswordAttemptsGlobal.delete(key);
}

async function hasUserIsLockedFlagColumn() {
  if (hasUserIsLockedFlagColumnCache !== null) return hasUserIsLockedFlagColumnCache;
  try {
    const r = await pool.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'odts'
          AND table_name = 'users'
          AND column_name = 'user_is_locked_flag'`
    );
    hasUserIsLockedFlagColumnCache = r.rows.length > 0;
  } catch (e) {
    hasUserIsLockedFlagColumnCache = false;
  }
  return hasUserIsLockedFlagColumnCache;
}

async function lockUserAfterFailedAttempts(userId) {
  if (!userId) return;
  try {
    if (await hasUserIsLockedFlagColumn()) {
      await pool.query(
        `UPDATE odts.users
            SET user_is_locked_flag = TRUE
          WHERE user_id = $1`,
        [userId]
      );
      return;
    }
  } catch (e) {
    console.error('[Auth] direct user_is_locked_flag update failed:', e.message);
  }
  await userModel.setUserLockedFlag(userId, true);
}

// ── /api/me — returns current session user (for Flutter / mobile clients) ────
router.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json(req.session.user);
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

// Landing page: Sign-in for unauthenticated users, dashboard for signed-in users
router.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  return res.redirect('/signin');
});

router.get('/signup', ensureAdminOrOfficeExecutive, async (req, res) => {
  try {
    await renderSignup(req, res, { error: null, success: null, formData: {} });
  } catch (err) {
    console.error(err);
    res.render('signup', { error: 'Unable to load page data', success: null, roles: [], dealers: [], existingUsers: [], formData: {} });
  }
});

router.post('/signup', ensureAdminOrOfficeExecutive, async (req, res) => {
  const {
    role_id,
    dealer_id,
    user_login_name,
    password,
    user_name,
    user_phone,
    user_email,
  } = req.body;

  const formData = {
    role_id: role_id || '',
    dealer_id: dealer_id || '',
    user_login_name: user_login_name || '',
    user_name: user_name || '',
    user_phone: user_phone || '',
    user_email: user_email || '',
  };

  try {
    const parsedRoleId = parseInt(role_id, 10);
    if (!parsedRoleId) {
      return renderSignup(req, res, { error: 'Role is mandatory.', formData });
    }

    const roleRes = await pool.query('SELECT role_id, role_name FROM odts.user_roles WHERE role_id = $1', [parsedRoleId]);
    if (!roleRes.rows.length) {
      return renderSignup(req, res, { error: 'Selected role is invalid.', formData });
    }
    const role = roleRes.rows[0];
    const isDealerRole = String(role.role_name || '').toUpperCase() === 'DEALER';

    let parsedDealerId = null;
    if (isDealerRole) {
      parsedDealerId = parseInt(dealer_id, 10);
      if (!parsedDealerId) {
        return renderSignup(req, res, { error: 'Dealer is mandatory for Dealer role.', formData });
      }

      const hasDealerActiveFlag = await hasTableColumn('dealers', 'dealer_is_active_flag');

      const dealerExists = await pool.query(
        `SELECT dealer_id
           FROM odts.dealers
          WHERE dealer_id = $1
            ${hasDealerActiveFlag ? 'AND COALESCE(dealer_is_active_flag, TRUE) = TRUE' : ''}`,
        [parsedDealerId]
      );
      if (!dealerExists.rows.length) {
        return renderSignup(req, res, { error: 'Selected dealer is invalid or inactive.', formData });
      }
    }

    if (!user_login_name || !String(user_login_name).trim()) {
      return renderSignup(req, res, { error: 'User login name is mandatory.', formData });
    }

    if (!password || !String(password).trim()) {
      return renderSignup(req, res, { error: 'Password is mandatory.', formData });
    }

    if (user_phone && !/^\d{10}$/.test(String(user_phone).trim())) {
      return renderSignup(req, res, { error: 'Phone must be exactly 10 digits when provided.', formData });
    }

    if (user_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(user_email).trim())) {
      return renderSignup(req, res, { error: 'Please provide a valid email address.', formData });
    }

    const existingLogin = await pool.query('SELECT user_id FROM odts.users WHERE user_login_name = $1', [String(user_login_name).trim()]);
    if (existingLogin.rows.length) {
      return renderSignup(req, res, { error: 'User login name already exists.', formData });
    }

    if (user_email && String(user_email).trim()) {
      const existingEmail = await pool.query('SELECT user_id FROM odts.users WHERE user_email = $1', [String(user_email).trim().toLowerCase()]);
      if (existingEmail.rows.length) {
        return renderSignup(req, res, { error: 'Email already exists.', formData });
      }
    }

    const createdBy = req.session && req.session.user && req.session.user.id ? req.session.user.id : 0;

    await userModel.createLoginUser({
      roleId: parsedRoleId,
      dealerId: isDealerRole ? parsedDealerId : null,
      userLoginName: String(user_login_name).trim(),
      password: String(password),
      userName: isDealerRole ? null : (user_name ? String(user_name).trim() : null),
      userPhone: isDealerRole ? null : (user_phone ? String(user_phone).trim() : null),
      userEmail: isDealerRole ? null : (user_email ? String(user_email).trim().toLowerCase() : null),
      createdBy,
    });

    return renderSignup(req, res, {
      success: 'Login user created successfully.',
      error: null,
      formData: {},
    });
  } catch (err) {
    console.error(err);
    return renderSignup(req, res, { error: 'Server error', formData });
  }
});

router.get('/signin', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('signin', { error: null });
});

router.post('/signin', async (req, res) => {
  // handle user name/password signin
  const { user_login_name, password } = req.body;
  if (!user_login_name || !password) return res.render('signin', { error: 'Provide user name and password' });

  const loginName = String(user_login_name || '').trim();
  try {
    const user = await userModel.findUserByLoginName(loginName);
    if (!user) {
      await insertAudit(req, { username: loginName }, 'PASSWORD', 'FAILED');
      return res.render('signin', { error: 'Invalid user name or password' });
    }

    if (!user.user_is_active_flag) {
      await insertAudit(req, { id: user.id, username: user.user_login_name || user.username, email: user.email, mobile: user.mobile || null, role: user.role }, 'PASSWORD', 'FAILED');
      return res.render('signin', { error: 'User is not active. Kindly contact Office' });
    }

    if (user.user_is_locked_flag) {
      await insertAudit(req, { id: user.id, username: user.user_login_name || user.username, email: user.email, mobile: user.mobile || null, role: user.role }, 'PASSWORD', 'FAILED');
      return res.render('signin', { error: 'User is locked due to multiple incorrect password. Kindly contact Office' });
    }

    const ok = await userModel.verifyPassword(password, user.password_hash);
    if (!ok) {
      await insertAudit(req, { id: user.id, username: user.user_login_name || user.username, email: user.email, mobile: user.mobile || null, role: user.role }, 'PASSWORD', 'FAILED');

      const failedAttemptsFromAudit = await userModel.countConsecutiveFailedPasswordAttempts(user.id);
      const failedAttemptsFromSession = incrementFailedAttempt(req, loginName);
      const failedAttemptsFromGlobal = incrementGlobalFailedAttempt(user.id, loginName);
      const failedAttempts = Math.max(failedAttemptsFromAudit || 0, failedAttemptsFromSession || 0, failedAttemptsFromGlobal || 0);

      if (failedAttempts >= 5) {
        await lockUserAfterFailedAttempts(user.id);
        clearFailedAttempt(req, loginName);
        clearGlobalFailedAttempt(user.id, loginName);
        return res.render('signin', { error: 'User is locked due to multiple incorrect password. Kindly contact Office' });
      }

      return res.render('signin', { error: 'Invalid user name or password' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      user_login_name: user.user_login_name || user.username,
      email: user.email,
      mobile: user.mobile || null,
      role: user.role || 'user',
      dealer_id: user.dealer_id || null
    };

    await userModel.updateUserLastLoginAt(user.id);
    clearFailedAttempt(req, loginName);
    clearGlobalFailedAttempt(user.id, loginName);
    const auditId = await insertAudit(req, req.session.user, 'PASSWORD', 'SUCCESS');
    if (req.session) req.session.loginAuditId = auditId || null;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('signin', { error: 'Server error' });
  }
});

// Request OTP for mobile number (POST /request-otp)
router.post('/request-otp', async (req, res) => {
  return res.status(403).json({
    type: 'disabled',
    error: 'Mobile / OTP sign-in is disabled as of now.'
  });
});

// Verify OTP (POST /verify-otp)
router.post('/verify-otp', async (req, res) => {
  return res.status(403).json({
    type: 'disabled',
    error: 'Mobile / OTP sign-in is disabled as of now.'
  });
});

router.get('/logout', async (req, res) => {
  const sid = req.session ? req.session.id : null;
  const userId = req.session && req.session.user ? req.session.user.id : null;
  const auditId = req.session ? req.session.loginAuditId : null;
  await markLogout({ sessionId: sid, userId, auditId });
  req.session.destroy(() => res.redirect('/signin'));
});

router.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.render('dashboard', { user: req.session.user });
});

module.exports = router;
