const express = require('express');
const router = express.Router();
const pool = require('../db');
const { generatePresignedUploadUrl, generatePresignedReadUrl } = require('../services/s3Service');
const path = require('path');
const fs = require('fs');

// Helper: Generate local upload URL for development
function generateLocalUploadUrl(dealerId, orderId, fileName) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const timestamp = Math.floor(now.getTime() / 1000);
  const ext = fileName.split('.').pop() || 'jpg';

  const dir = `receipts/${year}/${month}/${day}/${dealerId}`;
  const filename = `O${orderId}_${timestamp}.${ext}`;
  const uploadDir = path.join(process.cwd(), 'public/uploads', dir);

  // Create directory if it doesn't exist
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  return {
    uploadUrl: `/api/dispatcher/upload-local`,
    filePath: path.join(dir, filename),
    uploadPath: path.join(uploadDir, filename)
  };
}
const { broadcastOrderUpdate } = require('../services/sseService');

function ensureDispatcher(req, res, next) {
  if (!req.session?.user) {
    const isApiRoute = req.path.startsWith('/api/');
    return isApiRoute ? res.status(401).json({ error: 'Unauthorized' }) : res.redirect('/signin');
  }
  const role = req.session.user.role;
  if (role !== 'DISPATCHER' && role !== 'ADMIN' && role !== 'OFFICE_EXECUTIVE' && role !== 'SALES_OFFICER') {
    const isApiRoute = req.path.startsWith('/api/');
    return isApiRoute ? res.status(403).json({ error: 'Access denied.' }) : res.status(403).send('Access denied.');
  }
  return next();
}

// Generate presigned URLs for receipt images (or use local paths for development)
async function addPresignedUrlsToDispatcherOrders(orders) {
  try {
    for (const order of orders) {
      if (order.image_url && !order.image_url.includes('?')) {
        // For local storage, image_url is already a valid local path
        if (process.env.STORAGE_MODE === 'local') {
          console.log(`[Dispatcher] Using local image path: ${order.image_url}`);
          continue;
        }

        // For S3 storage, generate presigned URL
        const receiptIndex = order.image_url.indexOf('/receipts/');
        let s3Key = null;
        if (receiptIndex !== -1) {
          s3Key = order.image_url.substring(receiptIndex + 1);
        }
        if (s3Key) {
          try {
            console.log(`[Dispatcher] Generating presigned URL for: ${s3Key}`);
            const presignedUrl = await generatePresignedReadUrl(s3Key);
            order.image_url = presignedUrl;
          } catch (err) {
            console.error(`[Dispatcher] Failed to generate presigned URL for ${s3Key}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Dispatcher] Error adding presigned URLs:', err.message);
  }
  return orders;
}

// Resolve a stored receipt reference to a viewable URL.
// Handles: already-presigned URLs, external http(s) URLs, local /uploads paths,
// full S3 URLs (https://bucket/.../receipts/...), and bare S3 keys (receipts/...).
async function resolveReceiptUrl(url) {
  if (!url) return url;
  // Already a presigned URL (has query string) — use as-is
  if (url.includes('?')) return url;
  // Local static file — served directly
  if (url.startsWith('/uploads/')) return url;

  // Derive the S3 key
  let s3Key = null;
  const idx = url.indexOf('/receipts/');
  if (idx !== -1) {
    s3Key = url.substring(idx + 1); // strip leading slash (and any domain)
  } else if (url.startsWith('receipts/')) {
    s3Key = url;
  } else if (url.startsWith('http')) {
    // External URL with no /receipts/ segment (e.g. a test image) — use as-is
    return url;
  } else {
    return url;
  }

  try {
    return await generatePresignedReadUrl(s3Key);
  } catch (err) {
    console.error(`[Dispatcher] Failed to presign receipt ${s3Key}:`, err.message);
    return url;
  }
}

// Generate presigned read URLs for dispatch item receipt images
async function addPresignedUrlsToDispatchItems(items) {
  try {
    for (const item of items) {
      item.dispatch_receipt_image_url = await resolveReceiptUrl(item.dispatch_receipt_image_url);
    }
  } catch (err) {
    console.error('[Dispatcher] Error presigning dispatch item receipts:', err.message);
  }
  return items;
}

// Page route
router.get('/dispatcher', ensureDispatcher, (req, res) => {
  res.render('dispatcher/dashboard', { user: req.session.user, readOnlyMode: false });
});

// GET orders grouped for dispatcher view
router.get('/api/dispatcher/orders', ensureDispatcher, async (req, res) => {
  try {
    const { statuses, startDate, endDate } = req.query;
    const statusFilter = statuses ? statuses.split(',') : ['ORDER_PLACED', 'ACCEPTED'];

    const conditions = ['o.order_status = ANY($1::text[])'];
    const values = [statusFilter];
    let paramIndex = 2;

    if (startDate) {
      conditions.push(`o.order_date >= $${paramIndex++}::timestamp`);
      values.push(`${startDate}T00:00:00`);
    }
    if (endDate) {
      conditions.push(`o.order_date <= $${paramIndex++}::timestamp`);
      values.push(`${endDate}T23:59:59.999`);
    }

    const whereClause = conditions.join(' AND ');

    const result = await pool.query(`
      SELECT
        o.order_id,
        o.dealer_id,
        o.load_type_code,
        o.preferred_location_code,
        o.order_status,
        o.order_date,
        o.driver_name AS driver_name_on_order,
        o.driver_phone AS driver_phone_on_order,
        o.vehicle_number AS vehicle_number_on_order,
        d.dealer_name,
        d.dealer_company_name,
        (SELECT u.user_login_name
           FROM odts.user_master u
          WHERE u.dealer_id = o.dealer_id
            AND u.user_role_id = (SELECT role_id FROM odts.user_roles_master WHERE role_name = 'DEALER' LIMIT 1)
          LIMIT 1
        ) AS dealer_login_name,
        dp.party_company_name,
        dp.party_name AS party_name_col,
        dp.party_phone,
        dp.party_address,
        lt.code_desc AS load_type_desc,
        pl.warehouse_name  AS preferred_location_desc,
        od.dispatch_id,
        (SELECT COALESCE(json_agg(json_build_object(
            'item_id',       oi.item_id,
            'product_id',    oi.product_id,
            'product_name',  p.product_name,
            'order_bags',    oi.order_bags,
            'order_quantity', oi.order_quantity::text
          ) ORDER BY oi.item_id), '[]'::json)
         FROM odts.dealer_order_items oi
         LEFT JOIN odts.product_master p ON p.product_id = oi.product_id
         WHERE oi.order_id = o.order_id
        ) AS items
      FROM odts.dealer_orders o
      LEFT JOIN odts.dealer_master       d  ON d.dealer_id  = o.dealer_id
      LEFT JOIN odts.dealer_party_master  dp ON dp.party_id  = o.party_id
      LEFT JOIN odts.code_reference lt ON lt.code_type = 'loading_type' AND lt.code = o.load_type_code
      LEFT JOIN odts.warehouse_master pl ON pl.warehouse_code = o.preferred_location_code
      LEFT JOIN odts.order_dispatch od ON od.order_id  = o.order_id
      WHERE ${whereClause}
      ORDER BY o.dealer_id, o.order_date ASC
    `, values);

    const ordersWithPresignedUrls = await addPresignedUrlsToDispatcherOrders(result.rows);
    res.json(ordersWithPresignedUrls);
  } catch (e) {
    console.error('[Dispatcher] orders error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST accept: ORDER_PLACED → ACCEPTED (creates order_dispatch record)
router.post('/api/dispatcher/orders/:id/accept', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const userId = req.session.user.id;

    const existing = await pool.query(
      'SELECT order_id, order_status FROM odts.dealer_orders WHERE order_id = $1',
      [orderId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (existing.rows[0].order_status !== 'ORDER_PLACED') {
      return res.status(400).json({ error: `Order is ${existing.rows[0].order_status}, cannot accept` });
    }

    // Create order_dispatch record when order is accepted
    const dispatchExists = await pool.query(
      'SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1',
      [orderId]
    );

    if (!dispatchExists.rows.length) {
      await pool.query(
        `INSERT INTO odts.order_dispatch (order_id, created_by, updated_by)
         VALUES ($1, $2, $2)`,
        [orderId, userId]
      );
    }

    // Update order status to ACCEPTED
    await pool.query(
      `UPDATE odts.dealer_orders
          SET order_status = 'ACCEPTED', updated_by = $1, updated_at = NOW()
        WHERE order_id = $2`,
      [userId, orderId]
    );

    broadcastOrderUpdate({ orderId, newStatus: 'ACCEPTED', updatedBy: userId });
    res.json({ success: true });
  } catch (e) {
    console.error('[Dispatcher] accept error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST presigned URL for receipt upload
router.post('/api/dispatcher/presigned-url', ensureDispatcher, async (req, res) => {
  try {
    const { order_id, dealer_id, file_name, file_type } = req.body;

    if (!order_id || !dealer_id || !file_name || !file_type) {
      return res.status(400).json({ error: 'Missing required fields: order_id, dealer_id, file_name, file_type' });
    }

    console.log(`[Dispatcher] Presigned URL request: order=${order_id}, dealer=${dealer_id}, file=${file_name}, type=${file_type}`);

    // Check storage mode - use local storage for development
    if (process.env.STORAGE_MODE === 'local') {
      const localUrl = generateLocalUploadUrl(dealer_id, order_id, file_name);
      return res.json({
        url: localUrl.uploadUrl,
        s3Key: localUrl.filePath,
        isLocal: true
      });
    }

    const presignedUrl = await generatePresignedUploadUrl(dealer_id, order_id, file_name, file_type);
    res.json({
      ...presignedUrl,
      isLocal: false
    });
  } catch (error) {
    console.error('[Dispatcher] presigned URL error:', error);
    console.error('[Dispatcher] Error details:', error.message, error.code);
    res.status(500).json({ error: `Failed to generate upload URL: ${error.message}` });
  }
});

// POST local file upload handler (for local development only)
router.post('/api/dispatcher/upload-local', ensureDispatcher, async (req, res) => {
  try {
    const { filePath, fileData, order_id, dealer_id } = req.body;

    if (!filePath || !fileData) {
      return res.status(400).json({ error: 'Missing filePath or fileData' });
    }

    const uploadDir = path.join(process.cwd(), 'public/uploads');
    const fullPath = path.join(uploadDir, filePath);

    // Security: ensure path is within uploads directory
    if (!fullPath.startsWith(uploadDir)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    // Create directory if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Handle base64 or direct binary data
    let buffer;
    if (typeof fileData === 'string') {
      // Base64 encoded
      const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      buffer = Buffer.from(fileData);
    }

    fs.writeFileSync(fullPath, buffer);

    const localPath = `/uploads/${filePath}`;
    console.log(`[Dispatcher] File saved locally: ${localPath} (order=${order_id}, dealer=${dealer_id})`);

    res.json({
      success: true,
      image_url: localPath,
      ETag: Buffer.from(localPath).toString('base64').substring(0, 16),
      VersionId: null
    });
  } catch (error) {
    console.error('[Dispatcher] Local upload error:', error);
    res.status(500).json({ error: `Upload failed: ${error.message}` });
  }
});

// POST presigned read URL for S3 receipts (for displaying uploaded images)
router.post('/api/dispatcher/presigned-read-url', ensureDispatcher, async (req, res) => {
  try {
    const { s3Key } = req.body;

    if (!s3Key) {
      return res.status(400).json({ error: 's3Key is required' });
    }

    // Only local mode has no presigned reads; default (unset) uses S3
    if (process.env.STORAGE_MODE === 'local') {
      return res.status(400).json({ error: 'Read presigned URLs only for S3 mode' });
    }

    console.log(`[Dispatcher] Generating read presigned URL for: ${s3Key}`);
    const readUrl = await generatePresignedReadUrl(s3Key);
    res.json({ url: readUrl });
  } catch (e) {
    console.error('[Dispatcher] presigned read URL error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST dispatch: ACCEPTED → DISPATCHED via dispatch items
// Note: Dispatch details are now stored in order_dispatch_items table
// This endpoint is kept for backward compatibility - it simply updates order status
router.post('/api/dispatcher/orders/:id/dispatch', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const userId = req.session.user.id;

    const existing = await pool.query(
      'SELECT order_id, order_status FROM odts.dealer_orders WHERE order_id = $1',
      [orderId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (existing.rows[0].order_status !== 'ACCEPTED') {
      return res.status(400).json({ error: 'Order must be ACCEPTED before dispatching' });
    }

    // Verify dispatch record exists
    const dispatchExists = await pool.query(
      'SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1',
      [orderId]
    );
    if (!dispatchExists.rows.length) {
      return res.status(400).json({ error: 'Dispatch record not found. Order must be ACCEPTED first.' });
    }

    // Calculate and update order status based on dispatch items (PARTIALLY_DISPATCHED or FULLY_DISPATCHED)
    const newStatus = await calculateOrderStatus(orderId, pool);

    // Only update status if dispatch items exist (newStatus is not null)
    // If no items dispatched yet, status remains ACCEPTED
    if (newStatus) {
      await pool.query(
        `UPDATE odts.dealer_orders
            SET order_status = $1, updated_by = $2, updated_at = NOW()
          WHERE order_id = $3`,
        [newStatus, userId, orderId]
      );
      broadcastOrderUpdate({ orderId, newStatus, updatedBy: userId });
    }

    res.json({ success: true, order_status: newStatus || 'ACCEPTED' });
  } catch (e) {
    console.error('[Dispatcher] dispatch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/dispatcher/orders/:id/dispatch-quantities — update dispatch quantities in order_dispatch_items
router.patch('/api/dispatcher/orders/:id/dispatch-quantities', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { dispatchQuantities } = req.body; // Array of { item_id, dispatch_bags, dispatch_quantity, dispatch_notes }

    if (!Array.isArray(dispatchQuantities) || dispatchQuantities.length === 0) {
      return res.status(400).json({ error: 'Dispatch quantities are required' });
    }

    console.log(`[Dispatcher] Updating dispatch quantities for order ${orderId}:`, JSON.stringify(dispatchQuantities, null, 2));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get the dispatch_id for this order
      const dispatchRes = await client.query(
        `SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1`,
        [orderId]
      );

      if (dispatchRes.rows.length === 0) {
        throw new Error('No dispatch record found for this order');
      }

      const dispatch_id = dispatchRes.rows[0].dispatch_id;

      // Update each dispatch item with quantities and notes
      for (const item of dispatchQuantities) {
        const { item_id, dispatch_bags, dispatch_quantity, dispatch_notes } = item;

        if (!item_id || dispatch_bags === undefined || dispatch_quantity === undefined) {
          throw new Error('Invalid dispatch quantity data');
        }

        const dispatchBags = parseInt(dispatch_bags) || 0;
        const dispatchQty = parseFloat(dispatch_quantity) || 0;

        console.log(`[Dispatcher] Updating dispatch item ${item_id}: bags=${dispatchBags}, qty=${dispatchQty}`);

        // Update order_dispatch_items with dispatch quantities
        await client.query(
          `UPDATE odts.order_dispatch_items
           SET dispatch_bags = $1, dispatch_quantity = $2, dispatch_notes = $3, updated_by = $4, updated_at = NOW()
           WHERE dispatch_items_id = $5`,
          [dispatchBags, dispatchQty, dispatch_notes || null, req.session.user.id, parseInt(item_id)]
        );
      }

      // Calculate order status based on dispatch progress
      const newOrderStatus = await calculateOrderStatus(orderId, client);

      // Update order_status in dealer_orders
      await client.query(
        `UPDATE odts.dealer_orders
         SET order_status = $1, updated_by = $2, updated_at = NOW()
         WHERE order_id = $3`,
        [newOrderStatus, req.session.user.id, orderId]
      );

      console.log(`[Dispatcher] Successfully updated order ${orderId} to status: ${newOrderStatus}`);

      await client.query('COMMIT');

      res.json({
        success: true,
        order_status: newOrderStatus,
        message: `Dispatch updated to ${newOrderStatus} status`
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[Dispatcher] update dispatch quantities error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/dispatcher/orders/:id/dispatch — update dispatch details (vehicle, driver, bilty, location, receipt)
// Falls back to POST behavior (create if not exists) for admin convenience
router.patch('/api/dispatcher/orders/:id/dispatch', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { vehicle_number, driver_name, driver_phone, bilty_number, actual_loading_location_code, image_url, image_type, image_original_size, image_compressed_size } = req.body;

    console.log('[Dispatcher] Updating dispatch for order:', orderId, { vehicle_number, driver_name, driver_phone, bilty_number, actual_loading_location_code, image_url: image_url ? 'provided' : 'none' });

    // Check if order exists
    const orderCheck = await pool.query(
      'SELECT order_id, order_status FROM odts.dealer_orders WHERE order_id = $1',
      [orderId]
    );

    if (!orderCheck.rows.length) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if dispatch record exists
    const existing = await pool.query(
      'SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1',
      [orderId]
    );

    // If dispatch doesn't exist, create it
    let dispatch_id;
    const userId = req.session.user.id;

    if (!existing.rows.length) {
      const dispatchInsert = await pool.query(
        `INSERT INTO odts.order_dispatch (order_id, created_by, updated_by)
         VALUES ($1, $2, $2)
         RETURNING dispatch_id`,
        [orderId, userId]
      );
      dispatch_id = dispatchInsert.rows[0].dispatch_id;
    } else {
      dispatch_id = existing.rows[0].dispatch_id;
    }

    // Insert/update dispatch item details in order_dispatch_items
    const dispatchItemInsert = await pool.query(
      `INSERT INTO odts.order_dispatch_items (
        dispatch_id, dispatch_vehicle_number, dispatch_driver_name, dispatch_driver_phone,
        dispatch_bilty_number, dispatch_receipt_image_url, dispatch_receipt_image_type,
        dispatch_receipt_image_orig_size, dispatch_receipt_image_comp_size, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      RETURNING *`,
      [
        dispatch_id,
        vehicle_number?.trim().toUpperCase() || null,
        driver_name?.trim() || null,
        driver_phone?.trim() || null,
        bilty_number?.trim() || null,
        image_url || null,
        image_type || null,
        image_original_size || null,
        image_compressed_size || null,
        userId
      ]
    );

    // Update order status to DISPATCHED
    await pool.query(
      'UPDATE odts.dealer_orders SET order_status = $1, updated_by = $2, updated_at = NOW() WHERE order_id = $3',
      ['DISPATCHED', userId, orderId]
    );

    res.json({ success: true, message: 'Dispatch details updated successfully', dispatch_item: dispatchItemInsert.rows[0] });
  } catch (e) {
    console.error('[Dispatcher] update dispatch details error:', e.message, e.detail);
    res.status(500).json({ error: e.message });
  }
});

// DELETE receipt from dispatch
router.delete('/api/dispatcher/orders/:id/dispatch/receipt', ensureDispatcher, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);

    const existing = await pool.query(
      'SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1',
      [orderId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Dispatch record not found' });
    }

    await pool.query(`
      UPDATE odts.order_dispatch
      SET image_url = NULL,
          image_type = NULL,
          image_original_size = NULL,
          image_compressed_size = NULL,
          image_uploaded_at = NULL,
          updated_by = $1,
          updated_at = NOW()
      WHERE order_id = $2
    `, [req.session.user.id, orderId]);

    res.json({ success: true, message: 'Receipt deleted successfully' });
  } catch (e) {
    console.error('[Dispatcher] delete receipt error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Redirect old receipt URLs to new location
router.get('/receipts/:year/:month/:day/:dealerId/:filename', (req, res) => {
  const filePath = path.join(
    process.cwd(),
    'public/uploads/receipts',
    req.params.year,
    req.params.month,
    req.params.day,
    req.params.dealerId,
    req.params.filename
  );

  // Security: ensure path is within uploads directory
  const uploadDir = path.join(process.cwd(), 'public/uploads');
  if (!filePath.startsWith(uploadDir)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Send the file
  res.sendFile(filePath);
});

// ── Dispatch Items Management ──────────────────────────────────
// Simple auth check for dispatch items - any logged-in user
function ensureAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// Calculate order status based on dispatch progress
async function calculateOrderStatus(orderId, pool) {
  try {
    // Get total order bags from dealer_order_items
    const orderResult = await pool.query(
      `SELECT COALESCE(SUM(order_bags), 0) as total_order_bags
       FROM odts.dealer_order_items
       WHERE order_id = $1`,
      [orderId]
    );
    const totalOrderBags = parseInt(orderResult.rows[0]?.total_order_bags || 0);

    // Get total dispatched bags from order_dispatch_items
    const dispatchResult = await pool.query(
      `SELECT COALESCE(SUM(dispatch_bags), 0) as total_dispatch_bags
       FROM odts.order_dispatch_items odi
       INNER JOIN odts.order_dispatch od ON od.dispatch_id = odi.dispatch_id
       WHERE od.order_id = $1`,
      [orderId]
    );
    const totalDispatchBags = parseInt(dispatchResult.rows[0]?.total_dispatch_bags || 0);

    // Determine status based on dispatch progress
    let newStatus;
    if (totalOrderBags === totalDispatchBags && totalDispatchBags > 0) {
      newStatus = 'FULLY_DISPATCHED'; // All items dispatched
    } else if (totalDispatchBags > 0 && totalDispatchBags < totalOrderBags) {
      newStatus = 'PARTIALLY_DISPATCHED'; // Some items dispatched
    } else {
      // If no items dispatched yet, keep current status (ACCEPTED or DISPATCHED)
      return null;
    }

    return newStatus;
  } catch (e) {
    console.error('Error calculating order status:', e);
    return null;
  }
}

// GET dispatch items for an order
router.get('/api/orders/:orderId/dispatch-items', ensureAuth, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Check if table exists first
    const tableCheck = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'odts' AND table_name = 'order_dispatch_items'
      )`
    );

    if (!tableCheck.rows[0].exists) {
      // Table doesn't exist yet, return empty array
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT odi.*,
              pm.product_name,
              wm.warehouse_name AS actual_loading_location_code
       FROM odts.order_dispatch_items odi
       LEFT JOIN odts.product_master pm ON pm.product_id = odi.dispatch_product_id
       LEFT JOIN odts.warehouse_master wm ON wm.warehouse_id = odi.dispatch_warehouse_id
       WHERE odi.dispatch_id IN (SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1)
       AND odi.dispatch_product_id IS NOT NULL
       AND odi.dispatch_bags IS NOT NULL
       AND odi.dispatch_quantity IS NOT NULL
       ORDER BY odi.created_at DESC`,
      [orderId]
    );
    await addPresignedUrlsToDispatchItems(result.rows);
    res.json(result.rows);
  } catch (e) {
    console.error('Error fetching dispatch items:', e);
    // Return empty array instead of 500 error if table doesn't exist
    if (e.message && e.message.includes('does not exist')) {
      return res.json([]);
    }
    res.status(500).json({ error: e.message });
  }
});

// POST new dispatch item
router.post('/api/orders/:orderId/dispatch-items', ensureAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const {
      dispatch_bags,
      dispatch_quantity,
      dispatch_vehicle_number,
      dispatch_driver_name,
      dispatch_driver_phone,
      dispatch_bilty_number,
      dispatch_receipt_image_url,
      dispatch_receipt_image_type,
      dispatch_receipt_image_orig_size,
      dispatch_receipt_image_comp_size,
      dispatch_notes,
      product_id,
      dispatch_warehouse_id
    } = req.body;

    // Validate required fields
    if (!dispatch_bags || !dispatch_vehicle_number || !dispatch_driver_phone || !dispatch_bilty_number || !product_id) {
      return res.status(400).json({ error: 'Missing required fields: dispatch_bags, dispatch_vehicle_number, dispatch_driver_phone, dispatch_bilty_number, product_id' });
    }

    // Prevent empty/zero quantity dispatch
    if (dispatch_quantity <= 0 || parseInt(dispatch_bags) <= 0) {
      return res.status(400).json({ error: 'Dispatch quantity and bags must be greater than 0' });
    }

    // Get or create dispatch record for this order
    const dispatchResult = await pool.query(
      'SELECT dispatch_id FROM odts.order_dispatch WHERE order_id = $1',
      [orderId]
    );

    let dispatch_id;
    if (dispatchResult.rows.length === 0) {
      // Create new dispatch record
      const newDispatch = await pool.query(
        `INSERT INTO odts.order_dispatch (order_id, created_by, updated_by)
         VALUES ($1, $2, $2) RETURNING dispatch_id`,
        [orderId, req.session.user.id]
      );
      dispatch_id = newDispatch.rows[0].dispatch_id;
    } else {
      dispatch_id = dispatchResult.rows[0].dispatch_id;
    }

    // Validate dispatch quantity against order quantity for the product
    if (product_id) {
      // Get total order bags for this product
      const orderQtyResult = await pool.query(
        `SELECT COALESCE(SUM(order_bags), 0) as total_order_bags
         FROM odts.dealer_order_items
         WHERE order_id = $1 AND product_id = $2`,
        [orderId, product_id]
      );
      const totalOrderBags = parseInt(orderQtyResult.rows[0]?.total_order_bags || 0);

      // Get already dispatched bags for this product
      const dispatchedQtyResult = await pool.query(
        `SELECT COALESCE(SUM(dispatch_bags), 0) as total_dispatch_bags
         FROM odts.order_dispatch_items odi
         INNER JOIN odts.order_dispatch od ON od.dispatch_id = odi.dispatch_id
         WHERE od.order_id = $1 AND odi.dispatch_product_id = $2`,
        [orderId, product_id]
      );
      const alreadyDispatchedBags = parseInt(dispatchedQtyResult.rows[0]?.total_dispatch_bags || 0);

      const remainingBags = totalOrderBags - alreadyDispatchedBags;
      const dispatchQty = parseInt(dispatch_bags);

      if (dispatchQty > remainingBags) {
        return res.status(400).json({
          error: `Cannot dispatch ${dispatchQty} bags. Only ${remainingBags} bags remaining for this product (${totalOrderBags} ordered, ${alreadyDispatchedBags} already dispatched).`
        });
      }

      if (remainingBags === 0) {
        return res.status(400).json({
          error: 'All bags for this product have already been dispatched.'
        });
      }
    }

    // Insert dispatch item with warehouse_id
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert dispatch item (triggers will fire automatically)
      const insertQuery = `INSERT INTO odts.order_dispatch_items (
        dispatch_id, dispatch_bags, dispatch_quantity, dispatch_vehicle_number,
        dispatch_driver_name, dispatch_driver_phone, dispatch_bilty_number,
        dispatch_receipt_image_url, dispatch_receipt_image_type,
        dispatch_receipt_image_orig_size, dispatch_receipt_image_comp_size,
        dispatch_notes, dispatch_warehouse_id, dispatch_product_id, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`;

      const insertParams = [
        dispatch_id, parseInt(dispatch_bags), parseFloat(dispatch_quantity),
        dispatch_vehicle_number, dispatch_driver_name, dispatch_driver_phone,
        dispatch_bilty_number, dispatch_receipt_image_url, dispatch_receipt_image_type,
        dispatch_receipt_image_orig_size, dispatch_receipt_image_comp_size,
        dispatch_notes,
        dispatch_warehouse_id ? parseInt(dispatch_warehouse_id) : null,
        product_id ? parseInt(product_id) : null,
        req.session.user.id,
        req.session.user.id
      ];

      const result = await client.query(insertQuery, insertParams);
      const dispatchItem = result.rows[0];

      // Auto-create warehouse_stock entry for dispatch (marks as 'out')
      const stockResult = await client.query(`
        INSERT INTO odts.warehouse_stock (
          warehouse_id, warehouse_stock_date, warehouse_vehicle_number,
          warehouse_driver_name, warehouse_driver_phone, warehouse_bilty_number,
          warehouse_stock_notes, is_dispatch_out, created_by, updated_by
        ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, TRUE, $7, $7)
        RETURNING warehouse_stock_id
      `, [
        dispatch_warehouse_id ? parseInt(dispatch_warehouse_id) : null,
        dispatch_vehicle_number,
        dispatch_driver_name,
        dispatch_driver_phone,
        dispatch_bilty_number,
        `Dispatch Item #${dispatchItem.dispatch_id} - Order #${orderId}`,
        req.session.user.id
      ]);

      if (stockResult.rows.length > 0) {
        const warehouse_stock_id = stockResult.rows[0].warehouse_stock_id;
        // Create warehouse_stock_items with NEGATIVE quantity for dispatch
        // The fn_update_inventory_stock_in trigger will automatically update warehouse_inventory
        // current_qty = current_qty + (-dispatch_bags) = current_qty - dispatch_bags (decrement)
        await client.query(`
          INSERT INTO odts.warehouse_stock_items (
            warehouse_stock_id, warehouse_product_id, warehouse_product_qty, created_by, updated_by
          ) VALUES ($1, $2, $3, $4, $4)
        `, [
          warehouse_stock_id,
          product_id ? parseInt(product_id) : null,
          -parseInt(dispatch_bags),
          req.session.user.id
        ]);
      }

      await client.query('COMMIT');

      // Calculate and update order status based on dispatch progress
      const newStatus = await calculateOrderStatus(orderId, pool);
      if (newStatus) {
        await pool.query(
          `UPDATE odts.dealer_orders SET order_status = $1, updated_by = $2, updated_at = NOW()
           WHERE order_id = $3`,
          [newStatus, req.session.user.id, orderId]
        );
        // Notify all clients of the status change
        broadcastOrderUpdate({ orderId, newStatus, updatedBy: req.session.user.id });
      }

      res.json(result.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error creating dispatch item:', e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  } catch (e) {
    // This catches errors before the client is initialized
    console.error('Error creating dispatch item:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT update dispatch item
router.put('/api/dispatch-items/:itemId', ensureAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const {
      dispatch_bags,
      dispatch_quantity,
      dispatch_vehicle_number,
      dispatch_driver_name,
      dispatch_driver_phone,
      dispatch_bilty_number,
      dispatch_receipt_image_url,
      dispatch_receipt_image_type,
      dispatch_receipt_image_orig_size,
      dispatch_receipt_image_comp_size,
      dispatch_notes
    } = req.body;

    const result = await pool.query(
      `UPDATE odts.order_dispatch_items SET
        dispatch_bags = $1, dispatch_quantity = $2, dispatch_vehicle_number = $3,
        dispatch_driver_name = $4, dispatch_driver_phone = $5, dispatch_bilty_number = $6,
        dispatch_receipt_image_url = $7, dispatch_receipt_image_type = $8,
        dispatch_receipt_image_orig_size = $9, dispatch_receipt_image_comp_size = $10,
        dispatch_notes = $11, updated_by = $12, updated_at = NOW()
      WHERE dispatch_items_id = $13
      RETURNING *`,
      [
        dispatch_bags, dispatch_quantity, dispatch_vehicle_number,
        dispatch_driver_name, dispatch_driver_phone, dispatch_bilty_number,
        dispatch_receipt_image_url, dispatch_receipt_image_type,
        dispatch_receipt_image_orig_size, dispatch_receipt_image_comp_size,
        dispatch_notes, req.session.user.id, itemId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dispatch item not found' });
    }

    // Get order_id and recalculate status
    const dispatchItem = result.rows[0];
    const dispatchData = await pool.query(
      'SELECT order_id FROM odts.order_dispatch WHERE dispatch_id = (SELECT dispatch_id FROM odts.order_dispatch_items WHERE dispatch_items_id = $1)',
      [itemId]
    );

    if (dispatchData.rows.length > 0) {
      const orderId = dispatchData.rows[0].order_id;
      const newStatus = await calculateOrderStatus(orderId, pool);
      if (newStatus) {
        await pool.query(
          `UPDATE odts.dealer_orders SET order_status = $1, updated_by = $2, updated_at = NOW()
           WHERE order_id = $3`,
          [newStatus, req.session.user.id, orderId]
        );
      }
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Error updating dispatch item:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE dispatch item
router.delete('/api/dispatch-items/:itemId', ensureAuth, async (req, res) => {
  try {
    const { itemId } = req.params;

    // Get order_id before deletion
    const itemData = await pool.query(
      `SELECT od.order_id FROM odts.order_dispatch_items odi
       INNER JOIN odts.order_dispatch od ON od.dispatch_id = odi.dispatch_id
       WHERE odi.dispatch_items_id = $1`,
      [itemId]
    );

    await pool.query(
      'DELETE FROM odts.order_dispatch_items WHERE dispatch_items_id = $1',
      [itemId]
    );

    // Recalculate order status after deletion
    if (itemData.rows.length > 0) {
      const orderId = itemData.rows[0].order_id;
      const newStatus = await calculateOrderStatus(orderId, pool);
      if (newStatus) {
        await pool.query(
          `UPDATE odts.dealer_orders SET order_status = $1, updated_by = $2, updated_at = NOW()
           WHERE order_id = $3`,
          [newStatus, req.session.user.id, orderId]
        );
      }
    }

    res.json({ success: true, message: 'Dispatch item deleted' });
  } catch (e) {
    console.error('Error deleting dispatch item:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
