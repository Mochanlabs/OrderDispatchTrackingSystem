const express = require('express');
const router = express.Router();
const pool = require('../db');
const { sendAlert } = require('../services/smsService');
const { generatePresignedReadUrl } = require('../services/s3Service');
const { addClient, removeClient, broadcastOrderUpdate } = require('../services/sseService');

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

function ensureDealer(req, res, next) {
  if (!req.session || !req.session.user) {
    const isApiRoute = req.path.startsWith('/api/');
    return isApiRoute ? res.status(401).json({ error: 'Unauthorized' }) : res.redirect('/signin');
  }
  const role = req.session.user.role;
  if (role !== 'DEALER' && role !== 'ADMIN' && role !== 'DISPATCHER' && role !== 'OFFICE_EXECUTIVE') {
    const isApiRoute = req.path.startsWith('/api/');
    return isApiRoute ? res.status(403).json({ error: 'Access denied' }) : res.status(403).send('Access denied.');
  }
  return next();
}

const VALID_TRANSITIONS = {
  ORDER_PLACED:         ['ACCEPTED', 'ON_HOLD'],
  ACCEPTED:             ['ON_HOLD', 'DISPATCHED'],
  ON_HOLD:              ['ORDER_PLACED', 'ACCEPTED', 'DISPATCHED'],  // Can unhold back to ORDER_PLACED
  DISPATCHED:           ['FULLY_DISPATCHED', 'PARTIALLY_DISPATCHED'],
  FULLY_DISPATCHED:     [],
  PARTIALLY_DISPATCHED: ['FULLY_DISPATCHED'],
};

// Dispatcher can cancel orders from any status at any time
const DISPATCHER_ONLY_TRANSITIONS = ['CANCELLED'];

// Aggregate items from dealer_order_items table
const ITEMS_SUBQUERY = `
  (SELECT json_agg(json_build_object(
      'product_id',    doi.product_id,
      'product_name',  pm.product_name,
      'order_bags',    doi.order_bags,
      'order_quantity', doi.order_quantity::text
    ) ORDER BY doi.product_id)
   FROM odts.dealer_order_items doi
   LEFT JOIN odts.product_master pm ON pm.product_id = doi.product_id
   WHERE doi.order_id = o.order_id
  ) AS items
`;

// Aggregate dispatch items from order_dispatch_items table
const DISPATCH_ITEMS_SUBQUERY = `
  (SELECT json_agg(json_build_object(
      'dispatch_bags',    odi.dispatch_bags,
      'dispatch_quantity', odi.dispatch_quantity::text,
      'dispatch_driver_name', odi.dispatch_driver_name,
      'dispatch_driver_phone', odi.dispatch_driver_phone,
      'dispatch_vehicle_number', odi.dispatch_vehicle_number,
      'dispatch_bilty_number', odi.dispatch_bilty_number,
      'dispatch_notes', odi.dispatch_notes,
      'product_name', pm_dispatch.product_name,
      'actual_loading_location_code', wm_dispatch.warehouse_name,
      'created_at', odi.created_at::text
    ) ORDER BY odi.created_at DESC)
   FROM odts.order_dispatch_items odi
   LEFT JOIN odts.warehouse_master wm_dispatch ON wm_dispatch.warehouse_id = odi.dispatch_warehouse_id
   LEFT JOIN odts.product_master pm_dispatch ON pm_dispatch.product_id = odi.dispatch_product_id
   WHERE odi.dispatch_id IN (SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = o.order_id)
  ) AS dispatch_items
`;

function toOrderShape(row) {
  const rawItems = row.items;
  let items = [];
  if (rawItems) {
    const parsed = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
    if (Array.isArray(parsed)) items = parsed.filter(i => i && i.product_id);
  }
  const productName = items.length > 0
    ? items.map(i => i.product_name || `Product #${i.product_id}`).join(', ')
    : '';
  const totalQty = items.reduce((sum, i) => sum + parseFloat(i.order_quantity || 0), 0);

  const rawDispatchItems = row.dispatch_items;
  let dispatchItems = [];
  if (rawDispatchItems) {
    const parsed = typeof rawDispatchItems === 'string' ? JSON.parse(rawDispatchItems) : rawDispatchItems;
    if (Array.isArray(parsed)) dispatchItems = parsed.filter(i => i && (i.dispatch_bags || i.dispatch_driver_name || i.dispatch_vehicle_number));
  }

  const order = {
    order_id:                row.order_id,
    dealer_id:               row.dealer_id,
    dealer_name:             row.dealer_name || null,
    dealer_company_name:     row.dealer_company_name || null,
    items,
    product_name:            productName,
    quantity:                totalQty || parseFloat(row.order_quantity) || 0,
    unit:                    'MT',
    party_id:                row.party_id || null,
    party_name:              row.party_company_name || row.party_name_col || null,
    party_phone:             row.party_phone || null,
    party_address:           row.party_address || null,
    load_type_code:          row.load_type_code || null,
    load_type_desc:          row.load_type_desc || row.load_type_code || null,
    preferred_location_code: row.preferred_location_code || null,
    preferred_location_desc: row.preferred_location_desc || row.preferred_location_code || null,
    delivery_location:       row.preferred_location_desc || row.preferred_location_code || null,
    driver_name_on_order:    row.driver_name    || null,
    driver_phone_on_order:   row.driver_phone   || null,
    vehicle_number_on_order: row.vehicle_number || null,
    remarks:                 row.remarks || '',
    order_status:            row.order_status,
    on_hold_by:              row.on_hold_by || null,
    on_hold_reason:          row.on_hold_reason || null,
    on_hold_by_role:         row.on_hold_by_role || null,
    order_date:              row.order_date,
    dispatch:                null,
    dispatchItems:           dispatchItems,
    // Flat dispatch fields for sales/office views that read driver name directly off the order
    dispatch_driver_name:    dispatchItems.length > 0 ? (dispatchItems[0].dispatch_driver_name || null) : null,
    dispatch_driver_phone:   dispatchItems.length > 0 ? (dispatchItems[0].dispatch_driver_phone || null) : null,
    dispatch_vehicle_number: dispatchItems.length > 0 ? (dispatchItems[0].dispatch_vehicle_number || null) : null,
    dispatch_bilty_number:   dispatchItems.length > 0 ? (dispatchItems[0].dispatch_bilty_number || null) : null,
  };
  if (row.dispatch_id) {
    order.dispatch = {
      dispatch_id:                   row.dispatch_id,
      // Dispatch details now fetched from order_dispatch_items table
    };
  }
  return order;
}

// Generate presigned URLs for receipt images
async function addPresignedUrlsToOrders(orders) {
  try {
    console.log(`[Orders] Processing ${orders.length} orders for presigned URLs`);
    for (const order of orders) {
      if (order.dispatch && order.dispatch.image_url) {
        console.log(`[Orders] Order ${order.order_id}: image_url = ${order.dispatch.image_url}`);
        if (order.dispatch.image_url.includes('?')) {
          console.log(`[Orders] Order ${order.order_id}: Already presigned (has ?), skipping`);
          continue;
        }
        // Extract S3 key from URL (e.g., "https://bucket.s3.region.amazonaws.com/receipts/2026/05/05/4/O9_timestamp.jpg" → "receipts/2026/05/05/4/O9_timestamp.jpg")
        const receiptIndex = order.dispatch.image_url.indexOf('/receipts/');
        let s3Key = null;
        if (receiptIndex !== -1) {
          s3Key = order.dispatch.image_url.substring(receiptIndex + 1); // Remove leading slash
        }

        if (s3Key) {
          try {
            console.log(`[Orders] Generating presigned URL for order ${order.order_id}: ${s3Key}`);
            const presignedUrl = await generatePresignedReadUrl(s3Key);
            order.dispatch.image_url = presignedUrl;
            console.log(`[Orders] Order ${order.order_id}: Presigned URL generated successfully`);
          } catch (err) {
            console.error(`[Orders] Order ${order.order_id}: Failed to generate presigned URL for ${s3Key}:`, err.message);
            console.error(`[Orders] Error code:`, err.code);
            console.error(`[Orders] Full error:`, err);
            // Keep original URL if presigned URL generation fails
          }
        } else {
          console.log(`[Orders] Order ${order.order_id}: Could not extract S3 key from ${order.dispatch.image_url}`);
        }
      } else {
        console.log(`[Orders] Order ${order.order_id}: No dispatch/image_url`);
      }
    }
  } catch (err) {
    console.error('[Orders] Error adding presigned URLs:', err.message);
  }
  return orders;
}

async function getAdminPhone() {
  try {
    const result = await pool.query(
      `SELECT code_desc FROM odts.code_reference
       WHERE code_type = 'system_config' AND code = 'admin_phone' LIMIT 1`
    );
    return result.rows.length > 0 ? result.rows[0].code_desc : null;
  } catch (e) {
    console.error('Error fetching admin phone:', e);
    return null;
  }
}

async function getDealerDailyUsage(dealerId) {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(order_quantity), 0) as used_today,
        d.dealer_daily_limit
      FROM odts.dealer_orders o
      JOIN odts.dealer_master d ON d.dealer_id = o.dealer_id
      WHERE o.dealer_id = $1
        AND DATE(o.order_date) = CURRENT_DATE
        AND o.order_status IN ('ORDER_PLACED', 'ACCEPTED', 'ON_HOLD')
      GROUP BY d.dealer_id, d.dealer_daily_limit
    `, [dealerId]);

    if (result.rows.length === 0) {
      const dealerResult = await pool.query(
        'SELECT dealer_daily_limit FROM odts.dealer_master WHERE dealer_id = $1',
        [dealerId]
      );
      const dailyLimit = dealerResult.rows.length > 0 ? dealerResult.rows[0].dealer_daily_limit : 0;
      return {
        used_today: 0,
        daily_limit: dailyLimit || 0,
        remaining: dailyLimit || 0,
        percentage: 0
      };
    }

    const row = result.rows[0];
    const usedToday = parseFloat(row.used_today) || 0;
    const dailyLimit = parseFloat(row.dealer_daily_limit) || 0;
    const remaining = Math.max(0, dailyLimit - usedToday);
    const percentage = dailyLimit > 0 ? (usedToday / dailyLimit) * 100 : 0;

    return {
      used_today: usedToday,
      daily_limit: dailyLimit,
      remaining: remaining,
      percentage: percentage
    };
  } catch (e) {
    console.error('Error calculating daily usage:', e);
    return { used_today: 0, daily_limit: 0, remaining: 0, percentage: 0 };
  }
}

async function fetchOrders({ dealerId, startDate, endDate }) {
  const conditions = [];
  const values = [];
  let i = 1;
  if (dealerId)  { conditions.push(`o.dealer_id = $${i++}`);    values.push(dealerId); }
  if (startDate) { conditions.push(`o.order_date >= $${i++}`);  values.push(`${startDate}T00:00:00`); }
  if (endDate)   { conditions.push(`o.order_date <= $${i++}`);  values.push(`${endDate}T23:59:59.999`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT o.*,
           d.dealer_name, d.dealer_company_name,
           dp.party_company_name, dp.party_name AS party_name_col, dp.party_phone, dp.party_address,
           lt.code_desc       AS load_type_desc,
           wm.warehouse_name  AS preferred_location_desc,
           wm_actual.warehouse_name  AS actual_loading_location_desc,
           od.dispatch_id,
           ${ITEMS_SUBQUERY},
           ${DISPATCH_ITEMS_SUBQUERY}
    FROM odts.dealer_orders o
    LEFT JOIN odts.dealer_master       d  ON d.dealer_id  = o.dealer_id
    LEFT JOIN odts.dealer_party_master  dp ON dp.party_id  = o.party_id
    LEFT JOIN odts.code_reference lt ON lt.code_type = 'loading_type'     AND lt.code = o.load_type_code
    LEFT JOIN odts.warehouse_master wm ON wm.warehouse_code = o.preferred_location_code
    LEFT JOIN odts.order_dispatch od ON od.order_id  = o.order_id
    LEFT JOIN odts.warehouse_master wm_actual ON wm_actual.warehouse_code = o.preferred_location_code
    ${where}
    ORDER BY o.order_date DESC
  `;
  const result = await pool.query(sql, values);
  return result.rows.map(toOrderShape);
}

// ── Page routes ───────────────────────────────────────────────────────────────

// ── Auth middleware for office executives ───────────────────────────────────
function ensureAdminOrOfficeExecutive(req, res, next) {
  if (!req.session?.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/signin');
  }
  const role = req.session.user.role;
  if (role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE') return res.status(403).json({ error: 'Access denied.' });
  return next();
}

// ── Auth middleware for sales officers ───────────────────────────────────────
function ensureSalesOfficer(req, res, next) {
  if (!req.session?.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/signin');
  }
  const role = req.session.user.role;
  if (role !== 'SALES_OFFICER' && role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE') return res.status(403).json({ error: 'Access denied.' });
  return next();
}

// ── Auth middleware for admin only ─────────────────────────────────────────────
function ensureAdmin(req, res, next) {
  if (!req.session?.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/signin');
  }
  const role = req.session.user.role;
  if (role !== 'ADMIN') return res.status(403).json({ error: 'Access denied.' });
  return next();
}

// ── Auth middleware for any authenticated user ────────────────────────────────
function ensureAnyUser(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

// ── SSE subscribe endpoint for real-time order updates ────────────────────────
router.get('/api/orders/events', ensureAnyUser, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const { id: userId, role } = req.session.user;
  const clientId = addClient(res, userId, role);
  res.write(`event: connected\ndata: {"clientId":${clientId}}\n\n`);

  req.on('close', () => {
    removeClient(clientId);
  });
});

// ── Page routes ────────────────────────────────────────────────────────────

router.get('/orders', ensureDealer, (req, res) => {
  try {
    const role = req.session.user.role;
    const isAdmin = role === 'ADMIN' || role === 'DISPATCHER';
    const canViewAllOrders = role === 'ADMIN' || role === 'DISPATCHER' || role === 'OFFICE_EXECUTIVE';
    const isAdminOrOffice = role === 'ADMIN' || role === 'OFFICE_EXECUTIVE';
    const isDispatcher = role === 'DISPATCHER';

    // Determine return URL based on role
    let returnUrl;
    if (role === 'ADMIN') {
      returnUrl = '/admin/dealer-orders';  // Admins go to admin dealer orders view
    } else if (role === 'DISPATCHER' || role === 'OFFICE_EXECUTIVE') {
      returnUrl = '/orders';  // Dispatchers and office executives go to orders view
    } else {
      returnUrl = '/orders';  // Dealers go to their orders view (MY ORDERS)
    }

    console.log(`[/orders] User: ${req.session.user.username}, Role: '${role}', isDispatcher: ${isDispatcher}, isAdmin: ${isAdmin}`);
    if (req.query.action === 'new') {
      console.log('[/orders/new] Rendering new order form');
      return res.render('orders/new', { user: req.session.user, editOrderId: null, editDealerId: null, returnUrl });
    }
    if (req.query.action === 'edit' && req.query.id) {
      console.log('[/orders/edit] Rendering edit order form');
      return res.render('orders/new', { user: req.session.user, editOrderId: req.query.id, editDealerId: null, returnUrl });
    }
    console.log(`[/orders-render] Passing to view: isDispatcher=${isDispatcher}, isAdmin=${isAdmin}, isAdminOrOffice=${isAdminOrOffice}, canViewAllOrders=${canViewAllOrders}`);
    res.render('orders/index', { user: req.session.user, isAdmin, canViewAllOrders, isAdminOrOffice, isDispatcher });
  } catch (e) {
    console.error('[/orders] RENDER ERROR:', e.message, e.stack);
    res.status(500).send(`Error rendering orders page: ${e.message}`);
  }
});

// Admin: Dealer Orders (all dealers, T-2 days default)
// Shows same interface as dealer view, but for all dealers
router.get('/admin/dealer-orders', ensureAdmin, async (req, res) => {
  // Handle edit action
  if (req.query.action === 'edit' && req.query.id) {
    try {
      // Fetch the order to get dealer_id
      const orderResult = await pool.query('SELECT dealer_id FROM odts.dealer_orders WHERE order_id = $1', [req.query.id]);
      if (orderResult.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const dealerId = orderResult.rows[0].dealer_id;
      return res.render('orders/new', {
        user: req.session.user,
        editOrderId: req.query.id,
        editDealerId: dealerId,  // Pass dealer_id for loading parties
        returnUrl: '/admin/dealer-orders'  // Return to admin dealer orders view after save
      });
    } catch (e) {
      console.error('Error fetching order for edit:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - 2); // T-2 days
  const startDate = req.query.startDate || defaultStartDate.toISOString().split('T')[0];
  const endDate = req.query.endDate || new Date().toISOString().split('T')[0];
  res.render('orders/index', {
    user: req.session.user,
    isAdmin: true,
    canViewAllOrders: true,
    isAdminOrOffice: true,
    isDispatcher: false,
    isAdminDealerOrdersView: true,
    defaultStartDate: startDate,
    defaultEndDate: endDate
  });
});

// Admin: Dispatch Orders (all dispatcher orders, T-2 days default)
router.get('/admin/dispatch-orders', ensureAdmin, (req, res) => {
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - 2); // T-2 days
  const startDate = req.query.startDate || defaultStartDate.toISOString().split('T')[0];
  const endDate = req.query.endDate || new Date().toISOString().split('T')[0];
  res.render('dispatcher/dashboard', {
    user: req.session.user,
    defaultStartDate: startDate,
    defaultEndDate: endDate,
    isAdminDispatchOrders: true,
    readOnlyMode: false
  });
});

router.get('/office/dashboard', ensureAdminOrOfficeExecutive, (req, res) => {
  res.render('office/dashboard', { user: req.session.user });
});

router.get('/sales/dashboard', ensureSalesOfficer, (req, res) => {
  const defaultStartDate = new Date();
  defaultStartDate.setDate(defaultStartDate.getDate() - 3); // Last 3 days
  const startDate = req.query.startDate || defaultStartDate.toISOString().split('T')[0];
  const endDate = req.query.endDate || new Date().toISOString().split('T')[0];
  res.render('dispatcher/dashboard', {
    user: req.session.user,
    defaultStartDate: startDate,
    defaultEndDate: endDate,
    readOnlyMode: true
  });
});

router.get('/sales/report', ensureSalesOfficer, (req, res) => {
  res.render('sales/report', { user: req.session.user });
});

router.get('/orders/new', ensureDealer, (req, res) => {
  if (req.session.user.role !== 'DEALER') return res.redirect('/orders');
  res.render('orders/new', { user: req.session.user });
});

// ── API routes ────────────────────────────────────────────────────────────────

router.get('/api/admin/orders', ensureDealer, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let orders = await fetchOrders({ startDate, endDate });
    orders = await addPresignedUrlsToOrders(orders);
    res.json(orders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/dealer/limit', ensureDealer, async (req, res) => {
  try {
    const dealerId = req.session.user.dealer_id;
    const role = req.session.user.role;

    // Non-dealer users (ADMIN, DISPATCHER, OFFICE_EXECUTIVE) don't have dealer limits
    if (!dealerId || role !== 'DEALER') {
      return res.json({ daily_limit: null, used_today: 0, remaining: null, percentage: 0, admin_phone: null });
    }

    const usage = await getDealerDailyUsage(dealerId);
    const adminPhone = await getAdminPhone();
    res.json({ ...usage, admin_phone: adminPhone });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/dealer/orders', ensureDealer, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const role = req.session.user.role;
    const dealerId = role === 'DEALER' ? req.session.user.dealer_id : null;
    let orders = await fetchOrders({ dealerId, startDate, endDate });
    orders = await addPresignedUrlsToOrders(orders);
    res.json(orders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/office/orders', ensureAdminOrOfficeExecutive, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let orders = await fetchOrders({ startDate, endDate });
    orders = await addPresignedUrlsToOrders(orders);
    res.json(orders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/sales/orders', ensureSalesOfficer, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let orders = await fetchOrders({ startDate, endDate });
    orders = await addPresignedUrlsToOrders(orders);
    res.json(orders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Sales Report API ───────────────────────────────────────────────────────────
// Sales Report Monthly Data — accessible by ADMIN, OFFICE_EXECUTIVE, SALES_OFFICER
// Column Mapping:
// - Code → users.user_login_name (or user_name if user_login_name doesn't exist)
// - Order Date → dealer_orders.order_date (MAX for dealer summary, MIN for daily breakdown)
router.get('/api/sales/reports/monthly', ensureSalesOfficer, async (req, res) => {
  try {
    const { year, month } = req.query;
    const now = new Date();
    const reportYear = year ? parseInt(year) : now.getFullYear();
    const reportMonth = month ? parseInt(month) : now.getMonth() + 1;

    // Query 1: Dealer summary with status breakdown for this month
    const dealerSummary = await pool.query(`
      SELECT
        d.dealer_id,
        d.dealer_name,
        d.dealer_code,
        COUNT(DISTINCT o.order_id)::integer AS total_orders,
        SUM(oi.order_quantity)::numeric AS total_qty,
        COUNT(DISTINCT CASE WHEN o.order_status = 'ORDER_PLACED' THEN o.order_id END)::integer AS placed_count,
        COUNT(DISTINCT CASE WHEN o.order_status = 'ACCEPTED' THEN o.order_id END)::integer AS accepted_count,
        COUNT(DISTINCT CASE WHEN o.order_status IN ('DISPATCHED', 'FULLY_DISPATCHED', 'PARTIALLY_DISPATCHED') THEN o.order_id END)::integer AS dispatched_count,
        COUNT(DISTINCT CASE WHEN o.order_status = 'ON_HOLD' THEN o.order_id END)::integer AS on_hold_count
      FROM odts.dealer_orders o
      JOIN odts.dealer_order_items oi ON oi.order_id = o.order_id
      JOIN odts.dealer_master d ON d.dealer_id = o.dealer_id
      WHERE DATE_TRUNC('month', o.order_date) = make_date($1, $2, 1)
      GROUP BY d.dealer_id, d.dealer_name, d.dealer_code
      ORDER BY total_qty DESC
    `, [reportYear, reportMonth]);

    // Query 2: Product breakdown per dealer
    const productBreakdown = await pool.query(`
      SELECT d.dealer_id, p.product_name,
        COUNT(DISTINCT o.order_id)::integer AS order_count,
        COALESCE(SUM(oi.order_quantity), 0)::numeric AS total_qty
      FROM odts.dealer_orders o
      JOIN odts.dealer_master d ON d.dealer_id = o.dealer_id
      JOIN odts.dealer_order_items oi ON oi.order_id = o.order_id
      JOIN odts.product_master p ON p.product_id = oi.product_id
      WHERE DATE_TRUNC('month', o.order_date) = make_date($1, $2, 1)
      GROUP BY d.dealer_id, p.product_name
      ORDER BY d.dealer_id, p.product_name
    `, [reportYear, reportMonth]);

    // Query 3: Daily breakdown per dealer
    // Maps: Order Date=MIN(dealer_orders.order_date) with full timestamp
    const dailyBreakdown = await pool.query(`
      SELECT d.dealer_id, DATE(o.order_date) AS order_day, MIN(o.order_date) AS order_date,
        COUNT(DISTINCT o.order_id)::integer AS order_count,
        COALESCE(SUM(oi.order_quantity), 0)::numeric AS total_qty
      FROM odts.dealer_orders o
      JOIN odts.dealer_master d ON d.dealer_id = o.dealer_id
      JOIN odts.dealer_order_items oi ON oi.order_id = o.order_id
      WHERE DATE_TRUNC('month', o.order_date) = make_date($1, $2, 1)
      GROUP BY d.dealer_id, DATE(o.order_date)
      ORDER BY d.dealer_id, order_day
    `, [reportYear, reportMonth]);

    res.json({
      dealers: dealerSummary.rows,
      products: productBreakdown.rows,
      daily: dailyBreakdown.rows,
      year: reportYear,
      month: reportMonth
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/sales/reports/annual — 12-month trend data
router.get('/api/sales/reports/annual', ensureSalesOfficer, async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : new Date().getFullYear();

    const result = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM o.order_date)::integer AS month,
        TO_CHAR(o.order_date, 'MMM') AS month_name,
        SUM(oi.order_quantity)::numeric AS total_qty,
        COUNT(DISTINCT o.order_id)::integer AS total_orders
      FROM odts.dealer_orders o
      JOIN odts.dealer_order_items oi ON oi.order_id = o.order_id
      WHERE EXTRACT(YEAR FROM o.order_date) = $1
      GROUP BY EXTRACT(MONTH FROM o.order_date), TO_CHAR(o.order_date, 'MMM')
      ORDER BY EXTRACT(MONTH FROM o.order_date)
    `, [year]);

    res.json({ months: result.rows, year });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/notifications/quota-alerts — dealers at ≥80% of monthly target
router.get('/api/admin/notifications/quota-alerts', ensureAdminOrOfficeExecutive, async (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const result = await pool.query(`
      SELECT
        d.dealer_id,
        d.dealer_name,
        d.dealer_monthly_target,
        COALESCE(SUM(oi.order_quantity), 0)::numeric AS used_qty,
        CASE WHEN d.dealer_monthly_target > 0
          THEN ROUND((COALESCE(SUM(oi.order_quantity), 0) / d.dealer_monthly_target) * 100, 1)
          ELSE 0
        END AS percentage
      FROM odts.dealer_master d
      LEFT JOIN odts.dealer_orders o
        ON o.dealer_id = d.dealer_id
        AND DATE_TRUNC('month', o.order_date) = make_date($1, $2, 1)
        AND o.order_status IN ('ORDER_PLACED', 'ACCEPTED', 'DISPATCHED')
      LEFT JOIN odts.dealer_order_items oi ON oi.order_id = o.order_id
      WHERE d.dealer_monthly_target > 0
      GROUP BY d.dealer_id, d.dealer_name, d.dealer_monthly_target
      HAVING CASE WHEN d.dealer_monthly_target > 0
        THEN (COALESCE(SUM(oi.order_quantity), 0) / d.dealer_monthly_target) * 100
        ELSE 0 END >= 80
      ORDER BY percentage DESC
    `, [year, month]);

    res.json({ alerts: result.rows, month, year });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/dealer/orders/by-driver/:phone', ensureDealer, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').trim();
    const result = await pool.query(`
      SELECT o.*, d.dealer_name,
             od.dispatch_id, od.created_at AS dispatch_created_at,
             odi.dispatch_vehicle_number, odi.dispatch_driver_name, odi.dispatch_driver_phone AS dispatch_driver_phone,
             odi.dispatch_bilty_number,
             ${ITEMS_SUBQUERY}
      FROM odts.dealer_orders o
      LEFT JOIN odts.dealer_master d ON d.dealer_id = o.dealer_id
      INNER JOIN odts.order_dispatch od ON od.order_id = o.order_id
      INNER JOIN odts.order_dispatch_items odi ON odi.dispatch_id = od.dispatch_id
      WHERE odi.dispatch_driver_phone = $1
    `, [phone]);
    res.json(result.rows.map(toOrderShape));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/dealer/orders/:id', ensureDealer, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*,
             d.dealer_name,
             dp.party_company_name, dp.party_name AS party_name_col, dp.party_phone, dp.party_address,
             lt.code_desc AS load_type_desc,
             wm.warehouse_name AS preferred_location_desc,
             wm_actual.warehouse_name AS actual_loading_location_desc,
             od.dispatch_id,
             ${ITEMS_SUBQUERY}
      FROM odts.dealer_orders o
      LEFT JOIN odts.dealer_master       d  ON d.dealer_id  = o.dealer_id
      LEFT JOIN odts.dealer_party_master  dp ON dp.party_id  = o.party_id
      LEFT JOIN odts.code_reference lt ON lt.code_type = 'loading_type'     AND lt.code = o.load_type_code
      LEFT JOIN odts.warehouse_master wm ON wm.warehouse_code = o.preferred_location_code
      LEFT JOIN odts.order_dispatch od ON od.order_id  = o.order_id
      LEFT JOIN odts.warehouse_master wm_actual ON wm_actual.warehouse_code = o.preferred_location_code
      WHERE o.order_id = $1
    `, [parseInt(req.params.id)]);
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(toOrderShape(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/dealer/parties', ensureDealer, async (req, res) => {
  try {
    const dealer_id = req.session.user.dealer_id;
    if (!dealer_id) return res.json([]);
    const result = await pool.query(
      `SELECT dp.party_id, dp.party_code, dp.party_company_name, dp.party_name,
              dp.party_address, dp.party_phone
         FROM odts.dealer_party_master dp
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

router.post('/api/dealer/parties', ensureDealer, async (req, res) => {
  try {
    const dealer_id = req.session.user.dealer_id;
    if (!dealer_id) return res.status(400).json({ error: 'No dealer linked to this account.' });

    const { party_code, party_company_name, party_name, party_phone, party_email, party_address } = req.body;
    if (!party_company_name) return res.status(400).json({ error: 'Party company name is required.' });
    if (!party_phone) return res.status(400).json({ error: 'Party phone is required.' });
    if (!party_address) return res.status(400).json({ error: 'Party address is required.' });

    // Use provided party_code or auto-generate
    const finalPartyCode = party_code && party_code.trim()
      ? party_code.trim()
      : party_company_name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
        + '_' + Date.now().toString().slice(-5);

    const userId = req.session.user.id;
    if (!userId) return res.status(400).json({ error: 'User session invalid.' });

    const result = await pool.query(
      `INSERT INTO odts.dealer_party_master
         (dealer_id, party_code, party_company_name, party_name, party_phone, party_email, party_address, party_is_active_flag, created_by, created_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, NOW(), $8, NOW())
       RETURNING party_id, party_code, party_company_name, party_name, party_phone, party_email, party_address`,
      [dealer_id, finalPartyCode, party_company_name, party_name || null, party_phone, party_email || null, party_address, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/codes/:type', ensureDealer, async (req, res) => {
  try {
    const type = req.params.type;

    // Special handling for loading_location: fetch from warehouse_master
    if (type === 'loading_location') {
      const result = await pool.query(
        `SELECT
          warehouse_code AS code,
          warehouse_ui_label AS code_label,
          warehouse_name AS code_desc
        FROM odts.warehouse_master
        ORDER BY COALESCE(warehouse_ui_order, 999), warehouse_id`
      );
      return res.json(result.rows);
    }

    // For all other types, fetch from code_reference
    const result = await pool.query(
      `SELECT code, code_label, code_desc FROM odts.code_reference
        WHERE code_type = $1
        ORDER BY code_sort_order`,
      [type]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/dealer/products', ensureDealer, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_id, product_name FROM odts.product_master
        WHERE COALESCE(product_is_active_flag, TRUE) = TRUE
        ORDER BY product_name`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/parties/:dealer_id — get parties for a specific dealer (admin & office executive)
router.get('/api/admin/parties/:dealer_id', ensureDealer, async (req, res) => {
  try {
    const role = req.session.user.role;
    if (role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE') return res.status(403).json({ error: 'Only admins and office executives can access this' });

    const dealerId = parseInt(req.params.dealer_id);
    const result = await pool.query(`
      SELECT party_id, party_code, party_company_name, party_name, party_phone, party_address, party_is_active_flag
      FROM odts.dealer_party_master
      WHERE dealer_id = $1
      ORDER BY party_company_name
    `, [dealerId]);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/orders/on-behalf — admin & office executive create order for a dealer
router.post('/api/admin/orders/on-behalf', ensureDealer, async (req, res) => {
  try {
    const role = req.session.user.role;
    if (role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE') return res.status(403).json({ error: 'Only admins and office executives can create orders on behalf' });

    const { items, dealer_id, party_id, load_type_code, preferred_location_code,
            driver_name, driver_phone, vehicle_number } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one product item is required' });
    }
    if (!dealer_id) {
      return res.status(400).json({ error: 'Dealer ID is required' });
    }

    const KG_PER_BAG = 50;

    for (const [idx, item] of items.entries()) {
      if (!item.product_id) {
        return res.status(400).json({ error: `Row ${idx + 1}: product is required` });
      }
      if (!item.order_bags || parseInt(item.order_bags, 10) < 1) {
        return res.status(400).json({ error: `Row ${idx + 1}: number of bags is required` });
      }
      item.order_quantity = parseFloat((parseInt(item.order_bags, 10) * KG_PER_BAG / 1000).toFixed(3));
    }

    const totalQty = items.reduce((sum, i) => sum + i.order_quantity, 0);
    const firstProduct = parseInt(items[0].product_id, 10);

    // Check daily limit for this dealer
    const usage = await getDealerDailyUsage(dealer_id);
    const projectedTotal = usage.used_today + totalQty;

    if (usage.daily_limit > 0 && projectedTotal > usage.daily_limit) {
      return res.status(400).json({
        error: `Daily limit exceeded for this dealer. Limit: ${usage.daily_limit} MT, Used today: ${usage.used_today.toFixed(3)} MT, This order: ${totalQty.toFixed(3)} MT. Remaining: ${usage.remaining.toFixed(3)} MT`,
        daily_limit: usage.daily_limit,
        used_today: usage.used_today,
        remaining: usage.remaining
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(`
        INSERT INTO odts.dealer_orders
          (dealer_id, party_id, load_type_code, preferred_location_code,
           driver_name, driver_phone, vehicle_number,
           order_status, order_date, created_by, created_at, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'ORDER_PLACED', NOW(), $8, NOW(), $8, NOW())
        RETURNING *
      `, [
        dealer_id,
        party_id ? parseInt(party_id, 10) : null,
        load_type_code || null,
        preferred_location_code || null,
        driver_name ? driver_name.trim() : null,
        driver_phone ? driver_phone.trim() : null,
        vehicle_number ? vehicle_number.trim() : null,
        req.session.user.id,
      ]);

      const orderId = orderResult.rows[0].order_id;

      for (const item of items) {
        await client.query(`
          INSERT INTO odts.dealer_order_items (order_id, product_id, order_bags, order_quantity)
          VALUES ($1, $2, $3, $4)
        `, [
          orderId,
          parseInt(item.product_id, 10),
          item.order_bags ? parseInt(item.order_bags, 10) : null,
          parseFloat(item.order_quantity),
        ]);
      }

      await client.query('COMMIT');

      res.status(201).json({
        order_id: orderId,
        order_status: 'ORDER_PLACED',
        order_date: orderResult.rows[0].order_date,
        daily_limit: usage.daily_limit,
        used_today: projectedTotal,
        remaining_limit: Math.max(0, usage.daily_limit - projectedTotal),
        usage_percentage: usage.daily_limit > 0 ? (projectedTotal / usage.daily_limit) * 100 : 0
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Admin orders error:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// POST /api/dealer/orders — place a new order with one or more products
router.post('/api/dealer/orders', ensureDealer, async (req, res) => {
  const { items, party_id, load_type_code, preferred_location_code,
          driver_name, driver_phone, vehicle_number } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one product item is required' });
  }
  const KG_PER_BAG = 50;

  for (const [idx, item] of items.entries()) {
    if (!item.product_id) {
      return res.status(400).json({ error: `Row ${idx + 1}: product is required` });
    }
    if (!item.order_bags || parseInt(item.order_bags, 10) < 1) {
      return res.status(400).json({ error: `Row ${idx + 1}: number of bags is required` });
    }
    // Always compute quantity server-side from bags — ignore any client-supplied value
    item.order_quantity = parseFloat((parseInt(item.order_bags, 10) * KG_PER_BAG / 1000).toFixed(3));
  }

  // When load type is SELF_DOT, driver details are required
  if (load_type_code === 'SELF_DOT') {
    if (!driver_name || !driver_name.trim()) {
      return res.status(400).json({ error: 'Driver name is required for SELF_DOT orders' });
    }
    if (!driver_phone || !driver_phone.trim()) {
      return res.status(400).json({ error: 'Driver phone is required for SELF_DOT orders' });
    }
    if (!vehicle_number || !vehicle_number.trim()) {
      return res.status(400).json({ error: 'Vehicle number is required for SELF_DOT orders' });
    }
  }

  const dealer_id = req.session.user.dealer_id;
  if (!dealer_id) return res.status(400).json({ error: 'No dealer linked to this account.' });

  const userId       = req.session.user.id;
  const totalQty     = items.reduce((sum, i) => sum + i.order_quantity, 0);
  const firstProduct = parseInt(items[0].product_id, 10);

  // Check daily limit BEFORE placing order
  const usage = await getDealerDailyUsage(dealer_id);
  const projectedTotal = usage.used_today + totalQty;

  if (usage.daily_limit > 0 && projectedTotal > usage.daily_limit) {
    return res.status(400).json({
      error: `Daily limit exceeded. Limit: ${usage.daily_limit} MT, Used today: ${usage.used_today.toFixed(3)} MT, This order: ${totalQty.toFixed(3)} MT. Remaining: ${usage.remaining.toFixed(3)} MT`,
      daily_limit: usage.daily_limit,
      used_today: usage.used_today,
      remaining: usage.remaining
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(`
      INSERT INTO odts.dealer_orders
        (dealer_id, party_id, load_type_code, preferred_location_code,
         driver_name, driver_phone, vehicle_number,
         order_status, order_date, created_by, created_at, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'ORDER_PLACED', NOW(), $8, NOW(), $8, NOW())
      RETURNING *
    `, [
      dealer_id,
      party_id  ? parseInt(party_id, 10)   : null,
      load_type_code          || null,
      preferred_location_code || null,
      driver_name    ? driver_name.trim()    : null,
      driver_phone   ? driver_phone.trim()   : null,
      vehicle_number ? vehicle_number.trim() : null,
      userId,
    ]);

    const orderId = orderResult.rows[0].order_id;

    for (const item of items) {
      await client.query(`
        INSERT INTO odts.dealer_order_items (order_id, product_id, order_bags, order_quantity)
        VALUES ($1, $2, $3, $4)
      `, [
        orderId,
        parseInt(item.product_id, 10),
        item.order_bags ? parseInt(item.order_bags, 10) : null,
        parseFloat(item.order_quantity),
      ]);
    }

    await client.query('COMMIT');

    const newUsage = usage.daily_limit > 0
      ? { used_today: projectedTotal, daily_limit: usage.daily_limit, remaining: usage.daily_limit - projectedTotal, percentage: (projectedTotal / usage.daily_limit) * 100 }
      : { used_today: projectedTotal, daily_limit: 0, remaining: 0, percentage: 0 };

    // Send alert to admin if ≥80% threshold reached
    if (usage.daily_limit > 0 && newUsage.percentage >= 80) {
      const dealerResult = await pool.query('SELECT dealer_name FROM odts.dealer_master WHERE dealer_id = $1', [dealer_id]);
      const dealerName = dealerResult.rows.length > 0 ? dealerResult.rows[0].dealer_name : `Dealer #${dealer_id}`;
      const adminPhone = await getAdminPhone();
      if (adminPhone) {
        const alertMsg = `⚠️ Order Alert: Dealer "${dealerName}" reached ${newUsage.percentage.toFixed(0)}% of daily limit. Order #${orderId}: ${totalQty.toFixed(3)} MT. Limit: ${usage.daily_limit} MT, Remaining: ${newUsage.remaining.toFixed(3)} MT`;
        sendAlert(adminPhone, alertMsg).catch(err => {
          console.error('Failed to send admin alert SMS:', err);
        });
      }
    }

    res.status(201).json({
      order_id:     orderId,
      order_status: 'ORDER_PLACED',
      order_date:   orderResult.rows[0].order_date,
      daily_limit: newUsage.daily_limit,
      used_today: newUsage.used_today,
      remaining_limit: newUsage.remaining,
      usage_percentage: newUsage.percentage
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Dealer order creation error:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Server error' });
  } finally {
    client.release();
  }
});

// POST /api/admin/orders — Admin placing order on behalf of dealer
router.post('/api/admin/orders', ensureAdmin, async (req, res) => {
  const { dealer_id, items, party_id, load_type_code, preferred_location_code,
          driver_name, driver_phone, vehicle_number } = req.body;

  if (!dealer_id) {
    return res.status(400).json({ error: 'Dealer ID is required' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one product item is required' });
  }
  const KG_PER_BAG = 50;

  for (const [idx, item] of items.entries()) {
    if (!item.product_id) {
      return res.status(400).json({ error: `Row ${idx + 1}: product is required` });
    }
    if (!item.order_bags || parseInt(item.order_bags, 10) < 1) {
      return res.status(400).json({ error: `Row ${idx + 1}: number of bags is required` });
    }
    item.order_quantity = parseFloat((parseInt(item.order_bags, 10) * KG_PER_BAG / 1000).toFixed(3));
  }

  // When load type is SELF_DOT, driver details are required
  if (load_type_code === 'SELF_DOT') {
    if (!driver_name || !driver_name.trim()) {
      return res.status(400).json({ error: 'Driver name is required for SELF_DOT orders' });
    }
    if (!driver_phone || !driver_phone.trim()) {
      return res.status(400).json({ error: 'Driver phone is required for SELF_DOT orders' });
    }
    if (!vehicle_number || !vehicle_number.trim()) {
      return res.status(400).json({ error: 'Vehicle number is required for SELF_DOT orders' });
    }
  }

  const userId       = req.session.user.id;
  const totalQty     = items.reduce((sum, i) => sum + i.order_quantity, 0);
  const firstProduct = parseInt(items[0].product_id, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(`
      INSERT INTO odts.dealer_orders
        (dealer_id, party_id, load_type_code, preferred_location_code,
         driver_name, driver_phone, vehicle_number,
         order_status, order_date, created_by, created_at, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'ORDER_PLACED', NOW(), $8, NOW(), $8, NOW())
      RETURNING *
    `, [
      parseInt(dealer_id, 10),
      party_id  ? parseInt(party_id, 10)   : null,
      load_type_code          || null,
      preferred_location_code || null,
      driver_name    ? driver_name.trim()    : null,
      driver_phone   ? driver_phone.trim()   : null,
      vehicle_number ? vehicle_number.trim() : null,
      userId,
    ]);

    const orderId = orderResult.rows[0].order_id;

    for (const item of items) {
      await client.query(`
        INSERT INTO odts.dealer_order_items (order_id, product_id, order_bags, order_quantity)
        VALUES ($1, $2, $3, $4)
      `, [
        orderId,
        parseInt(item.product_id, 10),
        item.order_bags ? parseInt(item.order_bags, 10) : null,
        parseFloat(item.order_quantity),
      ]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      order_id:     orderId,
      order_status: 'ORDER_PLACED',
      order_date:   orderResult.rows[0].order_date
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Admin order creation error:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Server error' });
  } finally {
    client.release();
  }
});

// PUT /api/dealer/orders/:id — edit order details (only for ORDER_PLACED status)
router.put('/api/dealer/orders/:id', ensureDealer, async (req, res) => {
  const { items, party_id, load_type_code, preferred_location_code, driver_name, driver_phone, vehicle_number } = req.body;
  const orderId = parseInt(req.params.id);

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one product item is required' });
  }

  const KG_PER_BAG = 50;
  for (const [idx, item] of items.entries()) {
    if (!item.product_id) {
      return res.status(400).json({ error: `Row ${idx + 1}: product is required` });
    }
    if (!item.order_bags || parseInt(item.order_bags, 10) < 1) {
      return res.status(400).json({ error: `Row ${idx + 1}: number of bags is required` });
    }
    item.order_quantity = parseFloat((parseInt(item.order_bags, 10) * KG_PER_BAG / 1000).toFixed(3));
  }

  // When load type is SELF_DOT, driver details are required
  if (load_type_code === 'SELF_DOT') {
    if (!driver_name || !driver_name.trim()) {
      return res.status(400).json({ error: 'Driver name is required for SELF_DOT orders' });
    }
    if (!driver_phone || !driver_phone.trim()) {
      return res.status(400).json({ error: 'Driver phone is required for SELF_DOT orders' });
    }
    if (!vehicle_number || !vehicle_number.trim()) {
      return res.status(400).json({ error: 'Vehicle number is required for SELF_DOT orders' });
    }
  }

  const userRole = req.session.user.role;
  const userId = req.session.user.id;
  const totalQty = items.reduce((sum, i) => sum + i.order_quantity, 0);
  const firstProduct = parseInt(items[0].product_id, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch the order first to get its dealer_id
    const orderResult = await client.query(
      'SELECT * FROM odts.dealer_orders WHERE order_id = $1',
      [orderId]
    );
    if (!orderResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    const order_dealer_id = order.dealer_id;

    // Permission check: dealer can only edit their own orders, admin can edit any order
    if (userRole === 'DEALER' && req.session.user.dealer_id !== order_dealer_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to edit this order' });
    }

    // Check order status
    if (order.order_status !== 'ORDER_PLACED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Can only edit orders in ORDER_PLACED status' });
    }

    // Calculate old quantity for limit recalculation
    const oldQuantity = parseFloat(order.order_quantity) || 0;
    const quantityDiff = totalQty - oldQuantity;

    // Check daily limit only if quantity increased
    if (quantityDiff > 0) {
      const usage = await getDealerDailyUsage(order_dealer_id);
      const projectedTotal = usage.used_today + quantityDiff;

      if (usage.daily_limit > 0 && projectedTotal > usage.daily_limit) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Daily limit exceeded. Additional: ${quantityDiff.toFixed(3)} MT, Remaining: ${usage.remaining.toFixed(3)} MT`,
          daily_limit: usage.daily_limit,
          used_today: usage.used_today,
          remaining: usage.remaining
        });
      }
    }

    // Update the main order record
    await client.query(`
      UPDATE odts.dealer_orders
      SET party_id = $1,
          load_type_code = $2,
          preferred_location_code = $3,
          driver_name = $4,
          driver_phone = $5,
          vehicle_number = $6,
          updated_by = $7,
          updated_at = NOW()
      WHERE order_id = $8
    `, [
      party_id ? parseInt(party_id, 10) : null,
      load_type_code || null,
      preferred_location_code || null,
      driver_name ? driver_name.trim() : null,
      driver_phone ? driver_phone.trim() : null,
      vehicle_number ? vehicle_number.trim() : null,
      userId,
      orderId
    ]);

    // Delete existing items and insert new ones
    await client.query('DELETE FROM odts.dealer_order_items WHERE order_id = $1', [orderId]);
    for (const item of items) {
      await client.query(`
        INSERT INTO odts.dealer_order_items (order_id, product_id, order_bags, order_quantity)
        VALUES ($1, $2, $3, $4)
      `, [
        orderId,
        parseInt(item.product_id, 10),
        item.order_bags ? parseInt(item.order_bags, 10) : null,
        parseFloat(item.order_quantity),
      ]);
    }

    await client.query('COMMIT');

    res.json({
      order_id: orderId,
      order_status: 'ORDER_PLACED',
      message: 'Order updated successfully'
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.patch('/api/dealer/orders/:id/status', async (req, res) => {
  // Allow dealers, admins, office executives, and dispatchers
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const role = req.session.user.role;
  if (!['DEALER', 'ADMIN', 'DISPATCHER', 'OFFICE_EXECUTIVE'].includes(role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { status, reason } = req.body;

    const existing = await pool.query('SELECT * FROM odts.dealer_orders WHERE order_id = $1', [parseInt(req.params.id)]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = existing.rows[0];

    const allowed = VALID_TRANSITIONS[order.order_status] || [];
    if (!allowed.includes(status))
      return res.status(400).json({ error: `Cannot move order from "${order.order_status}" to "${status}".` });

    // ── ON_HOLD PERMISSION LOGIC ──
    // Dealer: can unhold only orders they held
    // Admin/Office: can unhold orders held by Admin or Office (NOT Dealer); they can work on each other's behalf
    // Dispatcher: CANNOT unhold
    if (status === 'ORDER_PLACED' && order.order_status === 'ON_HOLD') {
      const heldByRole = order.on_hold_by_role;

      // Dispatcher cannot unhold any orders
      if (role === 'DISPATCHER') {
        return res.status(403).json({ error: 'Dispatcher cannot unhold orders.' });
      }

      // Dealer can only unhold orders they held
      if (role === 'DEALER') {
        if (heldByRole && heldByRole !== 'DEALER') {
          return res.status(403).json({
            error: `Cannot unhold. This order is held by ${heldByRole}. Only ${heldByRole} can unhold it.`
          });
        }
      }
      // Admin and Office can unhold orders held by Admin or Office (but NOT by Dealer)
      else if (['ADMIN', 'OFFICE_EXECUTIVE'].includes(role)) {
        if (heldByRole === 'DEALER') {
          return res.status(403).json({
            error: `Cannot unhold. This order is held by dealer. Only the dealer can unhold their own orders.`
          });
        }
        // If heldByRole is Admin, Office, or NULL (backward compatibility), allow Admin/Office to unhold
      }
    }

    // Role-based reason validation: mandatory for ADMIN/OFFICE_EXECUTIVE, optional for DEALER
    if (status === 'ON_HOLD') {
      const isAdminRole = ['ADMIN', 'OFFICE_EXECUTIVE'].includes(role);
      if (isAdminRole && !reason?.trim()) {
        return res.status(400).json({ error: 'Hold reason is required for admin/office' });
      }
    }

    // Prepare update fields
    let updateFields = [status, req.session.user.id, parseInt(req.params.id)];
    let updateSQL = `
      UPDATE odts.dealer_orders SET
        order_status = $1,
        updated_by   = $2,
        updated_at   = NOW()`;
    let paramCount = 3;

    // Add on_hold fields when transitioning to ON_HOLD
    if (status === 'ON_HOLD') {
      updateSQL += `,
        on_hold_reason = $${++paramCount},
        on_hold_by = $${++paramCount},
        on_hold_by_role = $${++paramCount}`;
      updateFields.push(reason?.trim() || null, req.session.user.id, role);
    } else if (status === 'ORDER_PLACED' && order.order_status === 'ON_HOLD') {
      // Clear on_hold fields and reset order_date when releasing from ON_HOLD
      updateSQL += `,
        on_hold_reason = NULL,
        on_hold_by = NULL,
        on_hold_by_role = NULL,
        order_date = NOW()`;
    }

    updateSQL += ` WHERE order_id = $3 RETURNING *`;

    const updated = await pool.query(updateSQL, updateFields);

    broadcastOrderUpdate({ orderId: parseInt(req.params.id), newStatus: status, updatedBy: req.session.user.id });
    res.json(toOrderShape({ ...updated.rows[0], dealer_name: req.session.user.username }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/orders/:id/cancel — only admin can cancel orders
router.patch('/api/orders/:id/cancel', ensureDealer, async (req, res) => {
  try {
    const role = req.session.user.role;
    // Only ADMIN can cancel orders
    if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can cancel orders' });
    }

    const orderId = parseInt(req.params.id);
    const { cancellation_reason } = req.body;

    const existing = await pool.query('SELECT * FROM odts.dealer_orders WHERE order_id = $1', [orderId]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = existing.rows[0];
    const currentStatus = order.order_status;

    // Admin and Dispatcher can cancel from any status
    const result = await pool.query(
      `UPDATE odts.dealer_orders
       SET order_status = $1,
           updated_by = $2,
           updated_at = NOW()
       WHERE order_id = $3
       RETURNING *`,
      ['CANCELLED', req.session.user.id, orderId]
    );

    res.json({
      order_id: result.rows[0].order_id,
      order_status: 'CANCELLED',
      previous_status: currentStatus,
      cancelled_by: req.session.user.username,
      cancelled_at: new Date(),
      cancellation_reason: cancellation_reason || null
    });
  } catch (e) {
    console.error('Cancel order error:', e.message);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ── Report Dashboard Page Route ────────────────────────────────────────────────
router.get('/admin/reports', ensureAdmin, (req, res) => {
  res.render('admin/reports', { user: req.session.user });
});

// ── Reports API ────────────────────────────────────────────────────────────────
router.get('/api/admin/reports/monthly', ensureAdmin, async (req, res) => {
  try {
    const { year, month } = req.query;
    const now = new Date();
    const reportYear = year ? parseInt(year) : now.getFullYear();
    const reportMonth = month ? parseInt(month) : now.getMonth() + 1;

    const sql = `
      SELECT
        d.dealer_id,
        d.dealer_name,
        u.user_login_name,
        d.dealer_monthly_target,
        d.dealer_daily_limit,
        COALESCE(SUM(CASE
          WHEN DATE_TRUNC('month', o.order_date) = make_date($1, $2, 1)
            AND o.order_status != 'ON_HOLD'
          THEN oi.order_quantity ELSE 0
        END), 0)::integer AS current_month_total,
        COALESCE(SUM(CASE
          WHEN DATE_TRUNC('month', o.order_date) = make_date($1, $2, 1) - INTERVAL '1 month'
            AND o.order_status != 'ON_HOLD'
          THEN oi.order_quantity ELSE 0
        END), 0)::integer AS last_month_total
      FROM odts.dealer_master d
      LEFT JOIN odts.user_master u ON u.dealer_id = d.dealer_id AND u.user_role_id = 2
      LEFT JOIN odts.dealer_orders o ON o.dealer_id = d.dealer_id
      LEFT JOIN odts.dealer_order_items oi ON oi.order_id = o.order_id
      GROUP BY d.dealer_id, d.dealer_name, u.user_login_name, d.dealer_monthly_target, d.dealer_daily_limit
      ORDER BY d.dealer_name
    `;

    const result = await pool.query(sql, [reportYear, reportMonth]);
    const reports = result.rows.map(r => {
      const target = parseFloat(r.dealer_monthly_target) || 0;
      const actual = r.current_month_total;
      const achievement = target > 0 ? Math.round((actual / target) * 100) : 0;
      return {
        ...r,
        achievement,
        status: achievement >= 100 ? 'green' : achievement >= 70 ? 'orange' : 'red'
      };
    });

    res.json({ reports, year: reportYear, month: reportMonth });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
