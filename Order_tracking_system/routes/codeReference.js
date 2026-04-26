const express = require('express');
const router = express.Router();
const pool = require('../db');

const colCache = new Map();
let pkColCache = null;

async function hasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (colCache.has(key)) return colCache.get(key);
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'odts' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  const exists = r.rows.length > 0;
  colCache.set(key, exists);
  return exists;
}

async function getPkColumn() {
  if (pkColCache) return pkColCache;
  const r = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'odts'
      AND tc.table_name = 'code_reference'
      AND tc.constraint_type = 'PRIMARY KEY'
    LIMIT 1
  `);
  pkColCache = r.rows[0]?.column_name || null;
  return pkColCache;
}

function ensureAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  return next();
}

function ensureAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/signin');
  return next();
}

router.get('/master/code-reference', ensureAuth, (req, res) => {
  if (req.session.user.role !== 'ADMIN') return res.status(403).send('Access denied. Admin only.');
  res.render('master/code_reference', { user: req.session.user });
});

router.get('/api/code-reference/types', ensureAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT code_type FROM odts.code_reference ORDER BY code_type`
    );
    res.json(r.rows.map(r => r.code_type));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/code-reference', ensureAdmin, async (req, res) => {
  try {
    const { code_type } = req.query;
    const pk = await getPkColumn();
    const hasSortOrder  = await hasColumn('code_reference', 'code_sort_order');
    const hasIsActive   = await hasColumn('code_reference', 'is_active');
    const hasActiveFlag = await hasColumn('code_reference', 'code_is_active_flag');
    const hasCreatedAt  = await hasColumn('code_reference', 'created_at');
    const hasUpdatedAt  = await hasColumn('code_reference', 'updated_at');

    let sel = pk ? `${pk} AS id` : `code AS id`;
    sel += `, code_type, code, code_label, COALESCE(code_desc, '') AS code_desc`;
    if (hasSortOrder)  sel += `, code_sort_order`;
    if (hasIsActive)   sel += `, is_active`;
    else if (hasActiveFlag) sel += `, code_is_active_flag AS is_active`;
    else               sel += `, TRUE AS is_active`;
    if (hasCreatedAt)  sel += `, created_at`;
    if (hasUpdatedAt)  sel += `, updated_at`;

    const order = hasSortOrder
      ? 'ORDER BY code_type, code_sort_order, code'
      : 'ORDER BY code_type, code';

    let sql, params;
    if (code_type) {
      sql = `SELECT ${sel} FROM odts.code_reference WHERE code_type = $1 ${order}`;
      params = [code_type];
    } else {
      sql = `SELECT ${sel} FROM odts.code_reference ${order}`;
      params = [];
    }

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/code-reference', ensureAdmin, async (req, res) => {
  const { code_type, code, code_label, code_desc, code_sort_order, is_active } = req.body;
  if (!code_type || !code || !code_label)
    return res.status(400).json({ error: 'Code type, code and label are required' });
  try {
    const hasSortOrder  = await hasColumn('code_reference', 'code_sort_order');
    const hasIsActive   = await hasColumn('code_reference', 'is_active');
    const hasActiveFlag = await hasColumn('code_reference', 'code_is_active_flag');
    const hasCreatedAt  = await hasColumn('code_reference', 'created_at');
    const hasUpdatedAt  = await hasColumn('code_reference', 'updated_at');

    const cols = ['code_type', 'code', 'code_label', 'code_desc'];
    const vals = [code_type.trim(), code.trim(), code_label.trim(), (code_desc || '').trim()];
    const ph   = ['$1', '$2', '$3', '$4'];
    let i = 5;

    if (hasSortOrder)  { cols.push('code_sort_order'); vals.push(parseInt(code_sort_order) || 0); ph.push(`$${i++}`); }
    if (hasIsActive)   { cols.push('is_active'); vals.push(is_active !== false); ph.push(`$${i++}`); }
    else if (hasActiveFlag) { cols.push('code_is_active_flag'); vals.push(is_active !== false); ph.push(`$${i++}`); }
    if (hasCreatedAt)  { cols.push('created_at'); ph.push('NOW()'); }
    if (hasUpdatedAt)  { cols.push('updated_at'); ph.push('NOW()'); }

    const r = await pool.query(
      `INSERT INTO odts.code_reference (${cols.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`,
      vals
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/code-reference/:id', ensureAdmin, async (req, res) => {
  const { code_type, code, code_label, code_desc, code_sort_order, is_active } = req.body;
  if (!code_type || !code || !code_label)
    return res.status(400).json({ error: 'Code type, code and label are required' });
  try {
    const pk = await getPkColumn();
    if (!pk) return res.status(500).json({ error: 'Cannot identify primary key for code_reference table' });

    const hasSortOrder  = await hasColumn('code_reference', 'code_sort_order');
    const hasIsActive   = await hasColumn('code_reference', 'is_active');
    const hasActiveFlag = await hasColumn('code_reference', 'code_is_active_flag');
    const hasUpdatedAt  = await hasColumn('code_reference', 'updated_at');

    const set  = [`code_type=$1`, `code=$2`, `code_label=$3`, `code_desc=$4`];
    const vals = [code_type.trim(), code.trim(), code_label.trim(), (code_desc || '').trim()];
    let i = 5;

    if (hasSortOrder)  { set.push(`code_sort_order=$${i++}`); vals.push(parseInt(code_sort_order) || 0); }
    if (hasIsActive)   { set.push(`is_active=$${i++}`); vals.push(is_active !== false); }
    else if (hasActiveFlag) { set.push(`code_is_active_flag=$${i++}`); vals.push(is_active !== false); }
    if (hasUpdatedAt)  set.push('updated_at=NOW()');

    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE odts.code_reference SET ${set.join(', ')} WHERE ${pk}=$${i} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
