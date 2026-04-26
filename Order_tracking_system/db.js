const { Pool } = require('pg');
const { getPoolConfig } = require('./config/database');

const pool = new Pool(getPoolConfig());

module.exports = pool;
