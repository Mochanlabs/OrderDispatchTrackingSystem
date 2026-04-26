/**
 * Convert all plain text passwords to bcrypt hashes
 * Usage: node scripts/convert-passwords-to-hash.js
 */
const { getPoolConfig } = require('../config/database');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

function isBcryptHash(str) {
  // Bcrypt hashes start with $2a$, $2b$, or $2y$ and are 60 characters long
  return /^\$2[aby]\$\d{2}\$.{53}$/.test(str);
}

async function run() {
  const pool = new Pool(getPoolConfig());
  try {
    console.log('Fetching all users from database...\n');

    // Get all users
    const result = await pool.query(
      `SELECT user_id, user_login_name, password_hash
       FROM odts.users
       ORDER BY user_id`
    );

    const allUsers = result.rows;
    const plainTextUsers = allUsers.filter(u => !isBcryptHash(u.password_hash));

    console.log(`Total users: ${allUsers.length}`);
    console.log(`Plain text passwords found: ${plainTextUsers.length}\n`);

    if (plainTextUsers.length === 0) {
      console.log('✓ All passwords are already hashed!');
      await pool.end();
      return;
    }

    console.log('Converting plain text passwords to bcrypt hashes...\n');

    for (const user of plainTextUsers) {
      try {
        const plainPassword = user.password_hash;
        const hash = await bcrypt.hash(plainPassword, SALT_ROUNDS);
        
        await pool.query(
          `UPDATE odts.users SET password_hash = $1, updated_at = NOW()
           WHERE user_id = $2`,
          [hash, user.user_id]
        );
        
        console.log(`✓ User ID ${user.user_id} (${user.user_login_name}): "${plainPassword}" → hashed`);
      } catch (err) {
        console.error(`✗ Failed to update user ID ${user.user_id}: ${err.message}`);
      }
    }

    console.log(`\n✓ Converted ${plainTextUsers.length} plain text passwords to bcrypt hashes`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
