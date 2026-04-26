const pool = require('./db');
const { getSafeDbConfig } = require('./config/database');

async function findAndQuery(tableName) {
  // search for the table across schemas
  const q = `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema`;
  const res = await pool.query(q, [tableName]);
  if (!res.rows.length) return { found: false };

  const results = [];
  for (const r of res.rows) {
    const full = `${r.table_schema}.${r.table_name}`;
    try {
      const data = await pool.query(`SELECT * FROM ${r.table_schema}.${r.table_name} LIMIT 10`);
      results.push({ schema: r.table_schema, table: r.table_name, rows: data.rows });
    } catch (err) {
      results.push({ schema: r.table_schema, table: r.table_name, error: err.message });
    }
  }
  return { found: true, results };
}

async function run() {
  console.log('Using DB config:', {
    ...getSafeDbConfig(),
  });

  try {
    const now = await pool.query('SELECT now() as now');
    console.log('DB time:', now.rows[0].now);

    for (const t of ['user_roles', 'users']) {
      try {
        // prefer odts schema first
        const odtsCheck = await pool.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'odts' AND table_name = $1`,
          [t]
        );
        if (odtsCheck.rows.length) {
          try {
            const data = await pool.query(`SELECT * FROM odts.${t} LIMIT 10`);
            console.log(`Results for odts.${t}:`, data.rows);
            continue;
          } catch (err) {
            console.warn(`Could not query odts.${t}:`, err.message);
          }
        }

        const found = await findAndQuery(t);
        if (!found.found) {
          console.warn(`Table not found: ${t}`);
        } else {
          console.log(`Results for ${t}:`);
          for (const r of found.results) {
            if (r.error) console.warn(`- ${r.schema}.${r.table} -> ERROR: ${r.error}`);
            else console.log(`- ${r.schema}.${r.table}:`, r.rows);
          }
        }
      } catch (err) {
        console.error(`Error checking ${t}:`, err.message);
      }
    }
  } catch (err) {
    console.error('DB connection/query error:', err.message);
    process.exitCode = 1;
  } finally {
    try { await pool.end(); } catch (_) {}
  }
}

run();
