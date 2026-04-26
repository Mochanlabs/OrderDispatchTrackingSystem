require('dotenv').config();
const bcrypt = require('bcrypt');
const pool   = require('../db');

async function run() {
  const plain = 'Admin@123';
  const hash  = await bcrypt.hash(plain, 10);

  // find ADMIN role
  const roleRes = await pool.query("SELECT role_id FROM odts.user_roles WHERE role_name='ADMIN'");
  if (!roleRes.rows.length) { console.error('ADMIN role not found in odts.user_roles'); await pool.end(); return; }
  const roleId = roleRes.rows[0].role_id;
  console.log('ADMIN role_id:', roleId);

  // upsert admin user
  const existing = await pool.query("SELECT user_id FROM odts.users WHERE user_email='admin@odts.com'");
  if (existing.rows.length) {
    await pool.query(
      'UPDATE odts.users SET password_hash=$1, user_role_id=$2, user_is_active_flag=true, updated_at=now() WHERE user_email=$3',
      [hash, roleId, 'admin@odts.com']
    );
    console.log('Updated existing admin user password and role');
  } else {
    await pool.query(
      `INSERT INTO odts.users(user_name, user_email, user_phone, password_hash, user_role_id, user_is_active_flag, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,true,now(),now())`,
      ['Admin User', 'admin@odts.com', '9999999999', hash, roleId]
    );
    console.log('Created new admin user');
  }

  const check = await pool.query(
    "SELECT u.user_id, u.user_name, u.user_email, u.user_phone, r.role_name FROM odts.users u JOIN odts.user_roles r ON u.user_role_id=r.role_id WHERE u.user_email='admin@odts.com'"
  );
  console.log('\nAdmin user ready:', check.rows[0]);
  console.log('\nLogin credentials:');
  console.log('  Email   :', 'admin@odts.com');
  console.log('  Password:', plain);
  await pool.end();
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
