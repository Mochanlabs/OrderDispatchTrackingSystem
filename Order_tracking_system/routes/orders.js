const express = require('express');
const router = express.Router();
const pool = require('../db');

function ensureAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  return next();
}
function ensureDealer(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  const role = req.session.user.role;
  if (role !== 'DEALER' && role !== 'ADMIN' && role !== 'DISPATCHER') return res.status(403).send('Access denied.');
  return next();
}

// Valid status transitions
const VALID_TRANSITIONS = {
  ORDER_PLACED: ['ACCEPTED', 'ON_HOLD'],
  ACCEPTED:     ['DISPATCHED'],
  DISPATCHED:   [],
  ON_HOLD:      ['ORDER_PLACED'],
};

// Shape a DB row into the object the frontend expects
function toOrderShape(row) {
  const order = {
    order_id:                   row.order_id,
    dealer_id:                  row.dealer_id,
    dealer_name:                row.dealer_name || null,
    product_name:               row.product_name || String(row.product_id),
    quantity:                   row.order_quantity,
    unit:                       'MT',
    party_id:                   row.party_id || null,
    party_name:                 row.party_company_name || row.party_name_col || null,
    party_phone:                row.party_phone || null,
    party_address:              row.party_address || null,
    load_type_code:             row.load_type_code || null,
    load_type_desc:             row.load_type_desc || row.load_type_code || null,
    preferred_location_code:    row.preferred_location_code || null,
    preferred_location_desc:    row.preferred_location_desc || row.preferred_location_code || null,
    delivery_location:          row.preferred_location_desc || row.preferred_location_code || null,
    remarks:                    row.remarks || '',
    order_status:               row.order_status,
    on_hold_by:                 null,
    on_hold_reason:             null,
    order_date:                 row.order_date,
    dispatch:                   null,
  };
  if (row.dispatch_id) {
    order.dispatch = {
      dispatch_id:       row.dispatch_id,
      vehicle_no:        row.dispatch_vehicle_number || null,
      driver_name:       row.driver_name || null,
      driver_phone:      row.driver_phone || null,
      dispatch_date:     row.dispatch_created_at || null,
      dispatch_status:   null,
      expected_delivery: null,
      actual_delivery:   null,
    };
  }
  return order;
}

// Fetch orders with optional dealer + date filters
async function fetchOrders({ dealerId, startDate, endDate }) {
  const conditions = [];
  const values = [];
  let i = 1;
  if (dealerId) {
    conditions.push(`o.dealer_id = $${i++}`);
    values.push(dealerId);
  }
  if (startDate) {
    conditions.push(`o.order_date >= $${i++}`);
    values.push(`${startDate}T00:00:00`);
  }
  if (endDate) {
    conditions.push(`o.order_date <= $${i++}`);
    values.push(`${endDate}T23:59:59.999`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT o.*,
           d.dealer_name,
           p.product_name,
           dp.party_company_name, dp.party_name AS party_name_col, dp.party_phone, dp.party_address,
           lt.code_desc  AS load_type_desc,
           pl.code_desc  AS preferred_location_desc,
           od.dispatch_id, od.dispatch_vehicle_number, od.driver_id, od.created_at AS dispatch_created_at
    FROM odts.dealer_orders o
    LEFT JOIN odts.dealers d       ON d.dealer_id  = o.dealer_id
    LEFT JOIN odts.products p      ON p.product_id = o.product_id
    LEFT JOIN odts.dealer_party dp ON dp.party_id  = o.party_id
    LEFT JOIN odts.code_reference lt ON lt.code_type = 'loading_type'     AND lt.code = o.load_type_code
    LEFT JOIN odts.code_reference pl ON pl.code_type = 'loading_location' AND pl.code = o.preferred_location_code
    LEFT JOIN odts.order_dispatch od ON od.order_id = o.order_id
    ${where}
    ORDER BY o.order_date DESC
  `;
  const result = await pool.query(sql, values);
  return result.rows.map(toOrderShape);
}

// ── Page routes ───────────────────────────────────────────────────────────────

router.get('/orders', ensureDealer, (req, res) => {
  const role = req.session.user.role;
  const isAdmin = role === 'ADMIN' || role === 'DISPATCHER';
  if (!isAdmin && req.query.action === 'new') {
    return res.render('orders/new', { user: req.session.user });
  }
  res.render('orders/index', { user: req.session.user, isAdmin });
});

router.get('/orders/new', ensureDealer, (req, res) => {
  if (req.session.user.role !== 'DEALER') return res.redirect('/orders');
  res.render('orders/new', { user: req.session.user });
});

// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/admin/orders – all orders (admin/dispatcher)
router.get('/api/admin/orders', ensureDealer, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    res.json(await fetchOrders({ startDate, endDate }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dealer/orders – orders for the logged-in dealer
router.get('/api/dealer/orders', ensureDealer, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const role = req.session.user.role;
    const dealerId = role === 'DEALER' ? req.session.user.dealer_id : null;
    res.json(await fetchOrders({ dealerId, startDate, endDate }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dealer/orders/by-driver/:phone
router.get('/api/dealer/orders/by-driver/:phone', ensureDealer, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').trim();
    const result = await pool.query(`
      SELECT o.*, d.dealer_name,
             od.dispatch_id, od.dispatch_vehicle_number, od.driver_id, od.created_at
      FROM odts.dealer_orders o
      LEFT JOIN odts.dealers d ON d.dealer_id = o.dealer_id
      INNER JOIN odts.order_dispatch od ON od.order_id = o.order_id
      WHERE od.driver_id IS NOT NULL
    `, []);
    res.json(result.rows.map(toOrderShape));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dealer/orders/:id – single order
router.get('/api/dealer/orders/:id', ensureDealer, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, d.dealer_name,
             p.product_name,
             dp.party_company_name, dp.party_name AS party_name_col, dp.party_phone, dp.party_address,
             lt.code_desc AS load_type_desc,
             pl.code_desc AS preferred_location_desc,
             od.dispatch_id, od.dispatch_vehicle_number, od.driver_id, od.created_at AS dispatch_created_at
      FROM odts.dealer_orders o
      LEFT JOIN odts.dealers d       ON d.dealer_id  = o.dealer_id
      LEFT JOIN odts.products p      ON p.product_id = o.product_id
      LEFT JOIN odts.dealer_party dp ON dp.party_id  = o.party_id
      LEFT JOIN odts.code_reference lt ON lt.code_type = 'loading_type'     AND lt.code = o.load_type_code
      LEFT JOIN odts.code_reference pl ON pl.code_type = 'loading_location' AND pl.code = o.preferred_location_code
      LEFT JOIN odts.order_dispatch od ON od.order_id = o.order_id
      WHERE o.order_id = $1
    `, [parseInt(req.params.id)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(toOrderShape(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dealer/parties – parties linked to the logged-in dealer
router.get('/api/dealer/parties', ensureDealer, async (req, res) => {
  try {
    const dealer_id = req.session.user.dealer_id;
    if (!dealer_id) return res.json([]);
    const result = await pool.query(
      `SELECT dp.party_id, dp.party_code, dp.party_company_name, dp.party_name,
              dp.party_address, dp.party_phone
         FROM odts.dealer_party dp
        WHERE dp.dealer_id = $1
          AND COALESCE(dp.party_is_active_flag, TRUE) = TRUE
        ORDER BY dp.party_company_name`,
      [dealer_id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/dealer/parties – create a new party linked to the logged-in dealer
router.post('/api/dealer/parties', ensureDealer, async (req, res) => {
  try {
    const dealer_id = req.session.user.dealer_id;
    if (!dealer_id) return res.status(400).json({ error: 'No dealer linked to this account.' });

    const { party_company_name, party_phone, party_address } = req.body;
    if (!party_company_name) return res.status(400).json({ error: 'Party name is required.' });

    // Auto-generate a unique party_code from company name + timestamp
    const autoCode = party_company_name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
                     + '_' + Date.now().toString().slice(-5);

    const userId = req.session.user.id;
    if (!userId) return res.status(400).json({ error: 'User session invalid.' });

    const createdBy = userId;

    const result = await pool.query(
      `INSERT INTO odts.dealer_party
         (dealer_id, party_code, party_company_name, party_phone, party_address, party_is_active_flag, created_by, created_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, NOW(), $6, NOW())
       RETURNING party_id, party_company_name, party_phone, party_address`,
      [dealer_id, autoCode, party_company_name, party_phone || null, party_address || null, createdBy]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/codes/:type – fetch code_reference rows by code_type
router.get('/api/codes/:type', ensureDealer, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT code, code_label, code_desc FROM odts.code_reference
        WHERE code_type = $1
        ORDER BY code_sort_order`,
      [req.params.type]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dealer/products – active products for the dropdown
router.get('/api/dealer/products', ensureDealer, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_id, product_name FROM odts.products
        WHERE COALESCE(product_is_active_flag, TRUE) = TRUE
        ORDER BY product_name`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/dealer/orders – place a new order
router.post('/api/dealer/orders', ensureDealer, async (req, res) => {
  const { product_id, quantity, party_id, load_type_code, preferred_location_code } = req.body;

  if (!product_id || !quantity) {
    return res.status(400).json({
      error: 'Product ID and quantity are required'
    });
  }

  const dealer_id = req.session.user.dealer_id;
  if (!dealer_id) return res.status(400).json({ error: 'No dealer linked to this account.' });

  try {
    const userId = req.session.user.id;
    const result = await pool.query(`
      INSERT INTO odts.dealer_orders
        (dealer_id, product_id, order_quantity, party_id, load_type_code, preferred_location_code, order_status, order_date, created_by, created_at, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'ORDER_PLACED', NOW(), $7, NOW(), $7, NOW())
      RETURNING *
    `, [
      dealer_id,
      parseInt(product_id, 10),
      parseInt(quantity, 10),
      party_id ? parseInt(party_id, 10) : null,
      load_type_code || null,
      preferred_location_code || null,
      userId,
    ]);
    res.status(201).json(toOrderShape({ ...result.rows[0], dealer_name: req.session.user.username }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/dealer/orders/:id/status
router.patch('/api/dealer/orders/:id/status', ensureDealer, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const requesterRole = req.session.user.role;

    const existing = await pool.query('SELECT * FROM odts.dealer_orders WHERE order_id = $1', [parseInt(req.params.id)]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = existing.rows[0];

    const allowed = VALID_TRANSITIONS[order.order_status] || [];
    if (!allowed.includes(status))
      return res.status(400).json({
        error: `Cannot move order from "${order.order_status}" to "${status}".`
      });

    const updated = await pool.query(`
      UPDATE odts.dealer_orders SET
        order_status = $1,
        updated_by   = $2,
        updated_at   = NOW()
      WHERE order_id = $3
      RETURNING *
    `, [status, req.session.user.id, parseInt(req.params.id)]);

    res.json(toOrderShape({ ...updated.rows[0], dealer_name: req.session.user.username }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
