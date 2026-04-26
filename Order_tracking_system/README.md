# Order Tracking Management System

Order tracking app with signup/signin, role-based login, and PostgreSQL-backed data.

## Prerequisites

- Node 18+ / npm
- PostgreSQL, either:
  - local PostgreSQL on your machine, or
  - AWS RDS PostgreSQL

## Database configuration

Yes — having a dedicated configuration layer is the right approach when you want the same app to work with both a local database and AWS RDS.

This project now uses a shared config module in [config/database.js](config/database.js). It supports both of these connection styles:

### Option 1: Local PostgreSQL using separate fields

Copy `.env.example` to `.env` and set:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=odts_admin
DB_PASSWORD=admin123
DB_NAME=order_tracking
DB_SSL=false
```

### Option 2: AWS RDS PostgreSQL using a connection string

Set `DATABASE_URL` in `.env`:

```env
DATABASE_URL=postgresql://postgres:yourPassword@your-rds-endpoint.region.rds.amazonaws.com:5432/order_tracking
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
```

Notes:
- If `DATABASE_URL` is set, it automatically takes priority over `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.
- `DB_SSL=true` is typically required for AWS RDS.
- `DB_SSL_REJECT_UNAUTHORIZED=false` is a common starting point for RDS environments that do not yet have CA cert validation wired in.
- The same configuration is now reused by the main app and DB scripts.

## Database schema (run once)

```sql
CREATE TABLE IF NOT EXISTS user_roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(150) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT REFERENCES user_roles(id),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

-- Seed a default role
INSERT INTO user_roles(name) VALUES('user') ON CONFLICT (name) DO NOTHING;
INSERT INTO user_roles(name) VALUES('admin') ON CONFLICT (name) DO NOTHING;
```

## Install & run

```bash
cd /Users/ajitverma/Documents/local_copy_18apr/order_dispatch_tracking_system/Order_tracking_system
cp .env.example .env
# edit .env for local PostgreSQL or AWS RDS
npm install
npm run dev   # requires nodemon (dev dependency)
# or
npm start
```

## Files

- [server.js](server.js) - main Express server
- [db.js](db.js) - shared PostgreSQL pool
- [config/database.js](config/database.js) - reusable DB config for local PostgreSQL or AWS RDS
- [models/userModel.js](models/userModel.js) - simple user model
- [routes/auth.js](routes/auth.js) - signup/signin/logout/dashboard
- [views](views) - EJS templates
- [public/css/style.css](public/css/style.css) - styling

## Notes

- This is a minimal starter; for production use, secure the session secret, use HTTPS, store sessions persistently, validate inputs, and handle errors robustly.
- For production, prefer storing secrets in environment variables or your deployment platform's secret manager instead of committing `.env`.
