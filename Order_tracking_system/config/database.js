require('dotenv').config();

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildSslConfig() {
  const useSsl = parseBoolean(process.env.DB_SSL, false);
  if (!useSsl) return false;

  return {
    rejectUnauthorized: parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED, false),
  };
}

function getPoolConfig() {
  const baseConfig = {
    max: parseNumber(process.env.DB_POOL_MAX),
    idleTimeoutMillis: parseNumber(process.env.DB_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parseNumber(process.env.DB_CONNECTION_TIMEOUT_MS),
  };

  Object.keys(baseConfig).forEach((key) => {
    if (baseConfig[key] === undefined) delete baseConfig[key];
  });

  const ssl = buildSslConfig();
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl,
      ...baseConfig,
    };
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseNumber(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'odts_admin',
    password: process.env.DB_PASSWORD || 'admin123',
    database: process.env.DB_NAME || 'order_tracking',
    ssl,
    ...baseConfig,
  };
}

function maskConnectionString(connectionString) {
  if (!connectionString) return undefined;

  try {
    const url = new URL(connectionString);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch (_) {
    return '[set]';
  }
}

function getSafeDbConfig() {
  const config = getPoolConfig();

  if (config.connectionString) {
    return {
      mode: 'connection-string',
      connectionString: maskConnectionString(config.connectionString),
      ssl: Boolean(config.ssl),
      poolMax: config.max || undefined,
    };
  }

  return {
    mode: 'discrete-fields',
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    ssl: Boolean(config.ssl),
    poolMax: config.max || undefined,
  };
}

module.exports = {
  getPoolConfig,
  getSafeDbConfig,
};
