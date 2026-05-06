const db = require('../db');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;
const usersColumnCache = new Map();

async function hasUsersColumn(columnName) {
  if (usersColumnCache.has(columnName)) return usersColumnCache.get(columnName);
  const res = await db.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'odts'
        AND table_name = 'users'
        AND column_name = $1`,
    [columnName]
  );
  const exists = res.rows.length > 0;
  usersColumnCache.set(columnName, exists);
  return exists;
}

async function getLoginColumnName() {
  const hasLoginName = await hasUsersColumn('user_login_name');
  return hasLoginName ? 'user_login_name' : 'user_name';
}

async function getLockColumnName() {
  if (await hasUsersColumn('user_is_locked_flag')) return 'user_is_locked_flag';
  if (await hasUsersColumn('is_locked_flag')) return 'is_locked_flag';
  return null;
}

// The database uses `odts` schema with different column names; map them to our app's expected fields
async function findUserByLoginName(loginName) {
  const loginColumn = await getLoginColumnName();
  const lockColumn = await getLockColumnName();
  const lockExpr = lockColumn ? `u.${lockColumn}` : 'FALSE';
  const res = await db.query(
    `SELECT u.user_id as id,
            u.user_name as username,
            u.user_email as email,
            u.${loginColumn} as user_login_name,
            u.password_hash,
            u.dealer_id,
            r.role_name as role,
            u.user_role_id as role_id,
            COALESCE(u.user_is_active_flag, TRUE) as user_is_active_flag,
            COALESCE(${lockExpr}, FALSE) as user_is_locked_flag
     FROM odts.users u
     LEFT JOIN odts.user_roles r ON u.user_role_id = r.role_id
     WHERE u.${loginColumn} = $1`,
    [loginName]
  );
  return res.rows[0];
}

async function findUserById(id) {
  const loginColumn = await getLoginColumnName();
  const lockColumn = await getLockColumnName();
  const lockExpr = lockColumn ? `u.${lockColumn}` : 'FALSE';
  const res = await db.query(
    `SELECT u.user_id as id,
            u.user_name as username,
            u.user_email as email,
            u.${loginColumn} as user_login_name,
            u.dealer_id,
            r.role_name as role,
            u.user_role_id as role_id,
            COALESCE(u.user_is_active_flag, TRUE) as user_is_active_flag,
            COALESCE(${lockExpr}, FALSE) as user_is_locked_flag
     FROM odts.users u LEFT JOIN odts.user_roles r ON u.user_role_id = r.role_id WHERE u.user_id = $1`,
    [id]
  );
  return res.rows[0];
}

async function findUserByPhone(phone) {
  const loginColumn = await getLoginColumnName();
  const lockColumn = await getLockColumnName();
  const lockExpr = lockColumn ? `u.${lockColumn}` : 'FALSE';
  const res = await db.query(
    `SELECT u.user_id as id, u.user_name as username, u.user_email as email, u.user_phone as phone,
            u.${loginColumn} as user_login_name,
            u.password_hash, u.dealer_id, r.role_name as role, u.user_role_id as role_id,
            COALESCE(u.user_is_active_flag, TRUE) as user_is_active_flag,
            COALESCE(${lockExpr}, FALSE) as user_is_locked_flag
     FROM odts.users u LEFT JOIN odts.user_roles r ON u.user_role_id = r.role_id WHERE u.user_phone = $1`,
    [phone]
  );
  return res.rows[0];
}

async function createLoginUser({
  roleId,
  dealerId = null,
  userLoginName,
  password,
  userName = null,
  userPhone = null,
  userEmail = null,
  createdBy = 0,
}) {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  const columns = [];
  const values = [];
  const placeholders = [];
  let idx = 1;

  const addValue = (column, value) => {
    columns.push(column);
    values.push(value);
    placeholders.push(`$${idx++}`);
  };

  addValue('user_role_id', roleId);

  if (await hasUsersColumn('dealer_id')) addValue('dealer_id', dealerId);

  if (await hasUsersColumn('user_login_name')) addValue('user_login_name', String(userLoginName).trim());
  else addValue('user_name', String(userLoginName).trim());

  addValue('password_hash', hash);

  if (await hasUsersColumn('user_name')) addValue('user_name', userName ? String(userName).trim() : null);
  if (await hasUsersColumn('user_phone')) addValue('user_phone', userPhone ? String(userPhone).trim() : null);
  if (await hasUsersColumn('user_email')) addValue('user_email', userEmail ? String(userEmail).trim().toLowerCase() : null);
  if (await hasUsersColumn('user_is_active_flag')) addValue('user_is_active_flag', true);
  if (await hasUsersColumn('user_is_locked_flag')) addValue('user_is_locked_flag', false);
  else if (await hasUsersColumn('is_locked_flag')) addValue('is_locked_flag', false);
  if (await hasUsersColumn('created_by')) addValue('created_by', createdBy || 0);
  if (await hasUsersColumn('updated_by')) addValue('updated_by', createdBy || 0);

  if (await hasUsersColumn('created_at')) {
    columns.push('created_at');
    placeholders.push('NOW()');
  }
  if (await hasUsersColumn('updated_at')) {
    columns.push('updated_at');
    placeholders.push('NOW()');
  }

  const loginColumn = (await hasUsersColumn('user_login_name')) ? 'user_login_name' : 'user_name';

  const result = await db.query(
    `INSERT INTO odts.users (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING user_id as id,
               user_name as username,
               ${loginColumn} as user_login_name,
               user_email as email,
               user_role_id as role_id,
               dealer_id`,
    values
  );

  return result.rows[0];
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

async function setUserLockedFlag(userId, isLocked) {
  const lockColumn = await getLockColumnName();
  if (!lockColumn) return;

  if (await hasUsersColumn('updated_at')) {
    await db.query(
      `UPDATE odts.users
          SET ${lockColumn} = $1,
              updated_at = NOW()
        WHERE user_id = $2`,
      [Boolean(isLocked), userId]
    );
    return;
  }

  await db.query(
    `UPDATE odts.users
        SET ${lockColumn} = $1
      WHERE user_id = $2`,
    [Boolean(isLocked), userId]
  );
}

async function countConsecutiveFailedPasswordAttempts(userId) {
  try {
    const res = await db.query(
      `SELECT COUNT(*)::int AS failed_count
         FROM odts.user_login_audit a
        WHERE a.user_id = $1
          AND a.login_method = 'PASSWORD'
          AND a.login_status = 'FAILED'
          AND a.login_at > COALESCE(
                (
                  SELECT MAX(s.login_at)
                    FROM odts.user_login_audit s
                   WHERE s.user_id = $1
                     AND s.login_method = 'PASSWORD'
                     AND s.login_status = 'SUCCESS'
                ),
                TIMESTAMP '1970-01-01'
              )`,
      [userId]
    );
    return res.rows[0]?.failed_count || 0;
  } catch (e) {
    console.error('[Auth] failed-attempt lookup error:', e.message);
    return 0;
  }
}

async function updateUserLastLoginAt(userId) {
  if (!(await hasUsersColumn('user_last_login_at'))) return;

  if (await hasUsersColumn('updated_at')) {
    await db.query(
      `UPDATE odts.users
          SET user_last_login_at = NOW(),
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId]
    );
    return;
  }

  await db.query(
    `UPDATE odts.users
        SET user_last_login_at = NOW()
      WHERE user_id = $1`,
    [userId]
  );
}

module.exports = {
  findUserByLoginName,
  findUserById,
  findUserByPhone,
  createLoginUser,
  verifyPassword,
  setUserLockedFlag,
  countConsecutiveFailedPasswordAttempts,
  updateUserLastLoginAt,
};

