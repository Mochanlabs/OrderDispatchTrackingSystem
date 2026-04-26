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

// --- Page route (admin only) ---
router.get('/master/products', ensureAuth, (req, res) => {
  if (req.session.user.role !== 'ADMIN') return res.status(403).send('Access denied. Admin only.');
  res.render('master/products', { user: req.session.user });
});

// --- REST API ---

// GET all products
router.get('/api/products', ensureAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT product_id, product_name, product_desc, product_is_active_flag, created_at, updated_at FROM odts.products ORDER BY product_id'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// POST create product
router.post('/api/products', ensureAdmin, async (req, res) => {
  const { product_name, product_desc, product_is_active_flag } = req.body;
  if (!product_name) return res.status(400).json({ error: 'Product name is required' });
  try {
    const result = await pool.query(
      `INSERT INTO odts.products (product_name, product_desc, product_is_active_flag, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now()) RETURNING *`,
      [product_name.trim(), product_desc || '', product_is_active_flag !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT update product
router.put('/api/products/:id', ensureAdmin, async (req, res) => {
  const { id } = req.params;
  const { product_name, product_desc, product_is_active_flag } = req.body;
  if (!product_name) return res.status(400).json({ error: 'Product name is required' });
  try {
    const result = await pool.query(
      `UPDATE odts.products SET product_name=$1, product_desc=$2, product_is_active_flag=$3, updated_at=now()
       WHERE product_id=$4 RETURNING *`,
      [product_name.trim(), product_desc || '', product_is_active_flag !== false, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

module.exports = router;
