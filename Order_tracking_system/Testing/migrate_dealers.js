const { Pool } = require('pg');
const { getPoolConfig } = require('./config/database');

const pool = new Pool(getPoolConfig());

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE odts.dealers
        ADD COLUMN IF NOT EXISTS dealer_daily_limit    NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dealer_monthly_target NUMERIC(12,2) DEFAULT 0;
    `);
    console.log('Columns added (or already exist).');

    await client.query(`UPDATE odts.dealers SET dealer_daily_limit = 100, dealer_monthly_target = 2000 WHERE dealer_id = 2`);
    await client.query(`UPDATE odts.dealers SET dealer_daily_limit = 150, dealer_monthly_target = 3000 WHERE dealer_id = 3`);
    await client.query(`UPDATE odts.dealers SET dealer_daily_limit = 120, dealer_monthly_target = 2500 WHERE dealer_id = 4`);
    await client.query(`UPDATE odts.dealers SET dealer_daily_limit =  80, dealer_monthly_target = 1800 WHERE dealer_id = 5`);
    await client.query(`UPDATE odts.dealers SET dealer_daily_limit = 200, dealer_monthly_target = 4000 WHERE dealer_id = 6`);
    await client.query(`UPDATE odts.dealers SET dealer_daily_limit = 100, dealer_monthly_target = 2000 WHERE (dealer_daily_limit IS NULL OR dealer_daily_limit = 0)`);
    console.log('Sample data set.');

    const r = await client.query(`SELECT dealer_id, dealer_name, dealer_daily_limit, dealer_monthly_target FROM odts.dealers ORDER BY dealer_id`);
    console.table(r.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
