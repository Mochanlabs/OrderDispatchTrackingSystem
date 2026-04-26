/**
 * Update test users with proper bcrypt password hashes
 * Usage: node scripts/update-test-users.js
 */
const { getPoolConfig } = require('../config/database');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

async function run() {
  const pool = new Pool(getPoolConfig());
  try {
    console.log('Updating test users with bcrypt hashes...\n');

    // Test users: username = password (e.g., alpha1/alpha1)
    const testUsers = [
      'alpha1', 'alpha2', 'alpha3', 'alpha4', 'alpha5',
      'alpha6', 'alpha7', 'alpha8', 'alpha9', 'alpha10'
    ];

    for (const username of testUsers) {
      const hash = await bcrypt.hash(username, SALT_ROUNDS);
      await pool.query(
        `UPDATE odts.users SET password_hash = $1, updated_at = NOW()
         WHERE user_login_name = $2`,
        [hash, username]
      );
      console.log(`✓ Updated ${username}: password=${username}`);
    }

    console.log('\n✓ All test users updated with bcrypt hashes');
    console.log('\nYou can now login with:');
    testUsers.forEach(u => console.log(`  Username: ${u}  Password: ${u}`));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
