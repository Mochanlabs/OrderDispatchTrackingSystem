const { Pool } = require('pg');
const { getPoolConfig } = require('../config/database');

const pool = new Pool(getPoolConfig());

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS odts.user_login_audit (
        audit_id       SERIAL PRIMARY KEY,
        user_id        INTEGER,
        username       VARCHAR(100),
        email          VARCHAR(150),
        mobile         VARCHAR(15),
        role           VARCHAR(50),
        login_method   VARCHAR(20)  DEFAULT 'PASSWORD',
        login_status   VARCHAR(10)  DEFAULT 'SUCCESS',
        login_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
        logout_at      TIMESTAMP,
        ip_address     VARCHAR(45),
        user_agent     VARCHAR(500),
        session_id     VARCHAR(200),
        is_active      BOOLEAN      DEFAULT TRUE,
        created_at     TIMESTAMP    DEFAULT NOW(),
        CONSTRAINT fk_audit_user FOREIGN KEY (user_id)
          REFERENCES odts.users(user_id) ON DELETE SET NULL
      )
    `);
    console.log('Table created OK');

    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_login_at   ON odts.user_login_audit(login_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_is_active  ON odts.user_login_audit(is_active)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_session_id ON odts.user_login_audit(session_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_role       ON odts.user_login_audit(role)');
    console.log('Indexes created OK');
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    client.release();
    pool.end();
  }
}

run();
