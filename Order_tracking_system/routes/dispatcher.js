const express = require('express');
const router = express.Router();
const pool = require('../db');
const { generatePresignedUploadUrl, uploadFileToS3 } = require('../services/s3Service');

function ensureDispatcher(req, res, next) {
  if (!req.session?.user) return res.redirect('/signin');
  const role = req.session.user.role;
  if (role !== 'DISPATCHER' && role !== 'ADMIN') return res.status(403).send('Access denied. Dispatcher or Admin only.');
  return next();
}

// Page route
router.get('/dispatcher', ensureDispatcher, (req, res) => {
  res.render('dispatcher/dashboard', { user: req.session.user });
});

// GET orders grouped for dispatcher view
router.get('/api/dispatcher/orders', ensureDispatcher, async (req, res) => {
  try {
    const { statuses } = req.query;
    const statusFilter = statuses ? statuses.split(',') : ['ORDER_PLACED', 'ACCEPTED'];

    const result = await pool.query(`
      SELECT
        o.order_id,
        o.dealer_id,
        o.order_quantity,
        o.load_type_code,
        o.preferred_location_code,
        o.order_status,
        o.order_date,
        d.dealer_name,
        d.dealer_company_name,
        (SELECT u.user_login_name
           FROM odts.users u
          WHERE u.dealer_id = o.dealer_id
            AND u.user_role_id = (SELECT role_id FROM odts.user_roles WHERE role_name = 'DEALER' LIMIT 1)
          LIMIT 1
        ) AS dealer_login_name,
        dp.party_company_name,
        dp.party_name AS party_name_col,
        dp.party_phone,
        dp.party_address,
        lt.code_desc  AS load_type_desc,
        pl.code_desc  AS preferred_location_desc,
        od.dispatch_id,
        od.dispatch_vehicle_number,
        od.driver_name,
        od.driver_phone,
        od.bilty_number,
        od.actual_loading_location_code,
        al.code_desc  AS actual_location_desc,
        od.created_at AS dispatch_created_at,
        (SELECT COALESCE(json_agg(json_build_object(
            'product_id',    oi.product_id,
            'product_name',  p.product_name,
            'order_bags',    oi.order_bags,
            'order_quantity', oi.order_quantity::text
          ) ORDER BY oi.item_id), '[]'::json)
         FROM odts.dealer_order_items oi
         LEFT JOIN odts.products p ON p.product_id = oi.product_id
         WHERE oi.order_id = o.order_id
        ) AS items
      FROM odts.dealer_orders o
      LEFT JOIN odts.dealers       d  ON d.dealer_id  = o.dealer_id
      LEFT JOIN odts.dealer_party  dp ON dp.party_id  = o.party_id
      LEFT JOIN odts.code_reference lt ON lt.code_type = 'loading_type'     AND lt.code = o.load_type_code
      LEFT JOIN odts.code_reference pl ON pl.code_type = 'loading_location' AND pl.code = o.preferred_location_code
      LEFT JOIN odts.order_dispatch od ON od.order_id  = o.order_id
      LEFT JOIN odts.code_reference al ON al.code_type = 'loading_location' AND al.code = od.actual_loading_location_code
      WHERE o.order_status = ANY($1::text[])
      ORDER BY o.dealer_id, o.order_date ASC
    `, [statusFilter]);

    res.json(result.rows);
  } catch (e) {
    console.error('[Dispatcher] orders error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST accept: ORDER_PLACED → ACCEPTED
router.post('/api/dispatcher/orders/:id/accept', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const existing = await pool.query(
      'SELECT order_id, order_status FROM odts.dealer_orders WHERE order_id = $1',
      [orderId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (existing.rows[0].order_status !== 'ORDER_PLACED') {
      return res.status(400).json({ error: `Order is ${existing.rows[0].order_status}, cannot accept` });
    }
    await pool.query(
      `UPDATE odts.dealer_orders
          SET order_status = 'ACCEPTED', updated_by = $1, updated_at = NOW()
        WHERE order_id = $2`,
      [req.session.user.id, orderId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[Dispatcher] accept error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST file upload endpoint (backend uploads to S3)
router.post('/api/dispatcher/upload-receipt', ensureDispatcher, async (req, res) => {
  try {
    const { order_id, dealer_id, file_name, file_type, file_data } = req.body;

    if (!order_id || !dealer_id || !file_name || !file_type || !file_data) {
      return res.status(400).json({ error: 'Missing required fields: order_id, dealer_id, file_name, file_type, file_data' });
    }

    // Convert base64 to buffer
    const fileBuffer = Buffer.from(file_data, 'base64');

    console.log(`[Dispatcher] Receipt upload request: order=${order_id}, dealer=${dealer_id}, file=${file_name}, size=${fileBuffer.length} bytes`);
    const uploadResult = await uploadFileToS3(dealer_id, order_id, fileBuffer, file_name, file_type);
    res.json({
      success: true,
      image_url: uploadResult.s3Url,
      image_type: file_type,
      image_original_size: uploadResult.fileSize,
    });
  } catch (error) {
    console.error('[Dispatcher] Receipt upload error:', error);
    res.status(500).json({ error: `Failed to upload receipt: ${error.message}` });
  }
});

// POST presigned URL for receipt upload (legacy, kept for backward compatibility)
router.post('/api/dispatcher/presigned-url', ensureDispatcher, async (req, res) => {
  try {
    const { order_id, dealer_id, file_name, file_type } = req.body;

    if (!order_id || !dealer_id || !file_name || !file_type) {
      return res.status(400).json({ error: 'Missing required fields: order_id, dealer_id, file_name, file_type' });
    }

    console.log(`[Dispatcher] Presigned URL request: order=${order_id}, dealer=${dealer_id}, file=${file_name}, type=${file_type}`);
    const presignedUrl = await generatePresignedUploadUrl(dealer_id, order_id, file_name, file_type);
    res.json(presignedUrl);
  } catch (error) {
    console.error('[Dispatcher] presigned URL error:', error);
    console.error('[Dispatcher] Error details:', error.message, error.code);
    res.status(500).json({ error: `Failed to generate upload URL: ${error.message}` });
  }
});

// POST dispatch: ACCEPTED → DISPATCHED + create/update order_dispatch record
router.post('/api/dispatcher/orders/:id/dispatch', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { vehicle_number, driver_name, driver_phone, bilty_number, actual_loading_location_code, image_url, image_type, image_original_size, image_compressed_size } = req.body;

    if (!vehicle_number?.trim())                return res.status(400).json({ error: 'Vehicle number is required' });
    if (!driver_phone?.trim())                  return res.status(400).json({ error: 'Driver phone is required' });
    if (!bilty_number?.trim())                  return res.status(400).json({ error: 'Bilty number is required' });
    if (!actual_loading_location_code?.trim())  return res.status(400).json({ error: 'Actual loading location is required' });

    const existing = await pool.query(
      'SELECT order_id, order_status FROM odts.dealer_orders WHERE order_id = $1',
      [orderId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (existing.rows[0].order_status !== 'ACCEPTED') {
      return res.status(400).json({ error: 'Order must be ACCEPTED before dispatching' });
    }

    const userId       = req.session.user.id;
    const vehicleUpper = vehicle_number.trim().toUpperCase();

    const existingDispatch = await pool.query(
      'SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1',
      [orderId]
    );

    if (existingDispatch.rows.length) {
      await pool.query(
        `UPDATE odts.order_dispatch
            SET dispatch_vehicle_number      = $1,
                driver_name                  = $2,
                driver_phone                 = $3,
                bilty_number                 = $4,
                actual_loading_location_code = $5,
                image_url                    = COALESCE($8, image_url),
                image_type                   = COALESCE($9, image_type),
                image_original_size          = COALESCE($10, image_original_size),
                image_compressed_size        = COALESCE($11, image_compressed_size),
                image_uploaded_at            = CASE WHEN $8 IS NOT NULL THEN NOW() ELSE image_uploaded_at END,
                updated_by                   = $6,
                updated_at                   = NOW()
          WHERE dispatch_id = $7`,
        [vehicleUpper, driver_name || null, driver_phone.trim(),
         bilty_number.trim(), actual_loading_location_code.trim(),
         userId, existingDispatch.rows[0].dispatch_id,
         image_url || null, image_type || null, image_original_size || null, image_compressed_size || null]
      );
    } else {
      await pool.query(
        `INSERT INTO odts.order_dispatch
           (order_id, dispatch_vehicle_number, driver_name, driver_phone,
            bilty_number, actual_loading_location_code, image_url, image_type,
            image_original_size, image_compressed_size, image_uploaded_at,
            created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, NOW(), NOW())`,
        [orderId, vehicleUpper, driver_name || null, driver_phone.trim(),
         bilty_number.trim(), actual_loading_location_code.trim(),
         image_url || null, image_type || null, image_original_size || null,
         image_compressed_size || null, image_url ? 'NOW()' : null, userId]
      );
    }

    await pool.query(
      `UPDATE odts.dealer_orders
          SET order_status = 'DISPATCHED', updated_by = $1, updated_at = NOW()
        WHERE order_id = $2`,
      [userId, orderId]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('[Dispatcher] dispatch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
