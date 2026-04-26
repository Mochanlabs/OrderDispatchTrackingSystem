/**
 * Migration: create odts.orders and odts.dispatches tables
 * Run once: node scripts/migrate-orders-db.js
 */
const pool = require('../db');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS odts.orders (
        order_id                   SERIAL PRIMARY KEY,
        dealer_id                  INTEGER REFERENCES odts.dealers(dealer_id),
        product_name               VARCHAR(255) NOT NULL,
        quantity                   INTEGER NOT NULL CHECK (quantity > 0),
        unit                       VARCHAR(20) NOT NULL DEFAULT 'MT',
        party_name                 VARCHAR(255),
        delivery_address           TEXT,
        contact_number             VARCHAR(20),
        loading_type               VARCHAR(100),
        preferred_loading_location VARCHAR(255),
        remarks                    TEXT,
        order_status               VARCHAR(50) NOT NULL DEFAULT 'ORDER_PLACED',
        on_hold_by                 VARCHAR(50),
        on_hold_reason             TEXT,
        order_date                 TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at                 TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS odts.dispatches (
        dispatch_id       SERIAL PRIMARY KEY,
        order_id          INTEGER NOT NULL REFERENCES odts.orders(order_id) ON DELETE CASCADE,
        vehicle_no        VARCHAR(50),
        driver_name       VARCHAR(255),
        driver_phone      VARCHAR(20),
        dispatch_date     TIMESTAMP,
        dispatch_status   VARCHAR(50),
        expected_delivery DATE,
        actual_delivery   DATE,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('Migration complete: odts.orders and odts.dispatches tables ready.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
