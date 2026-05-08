# CLAUDE.md — Order Dispatch Tracking System (ODTS)

## Company
Mochan Labs — builds websites, webapps, digital marketing, Python scripts, automation.

## Project Purpose
Internal order dispatch and tracking system for a distribution/dealer business.
Dealers place orders → Admin/Dispatcher accepts and dispatches → Driver tracked live via GPS.

---

## Stack

| Layer       | Technology                                      |
|-------------|--------------------------------------------------|
| Runtime     | Node.js 18+, Express 4                          |
| Templating  | EJS (server-rendered), React 18 via CDN (inline) |
| Database    | PostgreSQL — `odts` schema                       |
| Auth        | express-session (in-memory, 24h cookie)          |
| Passwords   | bcrypt (10 rounds)                              |
| Live Track  | Firebase Realtime Database                       |
| SMS         | MSG91 / Twilio / dev-console (abstracted)        |
| CSS         | Bootstrap 5 (CDN) + custom `public/css/style.css`|
| Deployment  | AWS Elastic Beanstalk (port 8080), local (3000)  |

---

## File Map

```
server.js               — Express app entry point, session setup, route mounting
db.js                   — pg Pool singleton (uses config/database.js)
config/database.js      — DB config: local fields OR DATABASE_URL (RDS)
models/userModel.js     — User CRUD + bcrypt verify + lock/audit helpers
routes/
  auth.js               — signin, signup, logout, /dashboard, /api/me, audit
  orders.js             — dealer order CRUD + dispatch view (/orders, /api/dealer/orders)
  tracking.js           — live tracking page + Firebase config endpoint
  driver.js             — /driver/track (NO auth — public URL for driver)
  dealers.js            — /master/dealers, /api/dealers (ADMIN only)
  party.js              — /master/party, /api/party (ADMIN only)
  products.js           — /master/products, /api/products (ADMIN only)
  locations.js          — /master/locations, /api/locations (ADMIN only)
  masterUsers.js        — /master/users, /api/master/users (ADMIN only)
  userRoles.js          — /master/user-roles, /api/user-roles (ADMIN only)
  codeReference.js      — /master/code-reference, /api/code-reference (ADMIN only)
  audit.js              — /admin/sessions, /api/admin/active-sessions, /api/admin/login-report
services/
  smsService.js         — SMS OTP abstraction (dev/MSG91/Twilio via SMS_PROVIDER env)
views/
  signin.ejs / signup.ejs / dashboard.ejs / layout.ejs
  orders/index.ejs      — React-powered order list (CDN React + Babel)
  orders/new.ejs        — New order form
  tracking/index.ejs    — Live GPS tracking (Google Maps + Firebase)
  driver/track.ejs      — Driver GPS upload page (no auth)
  master/               — Admin master data pages (dealers, products, party, etc.)
  admin/sessions.ejs    — Login audit/sessions
  partials/header.ejs + footer.ejs
scripts/                — One-time DB migration and seed scripts
Testing/                — Smoke tests, endpoint tests, DB tests
```

---

## Database Schema (`odts` schema)

### Core tables
| Table               | Key columns / purpose                                                 |
|---------------------|-----------------------------------------------------------------------|
| `users`             | user_id, user_login_name, user_name, user_email, user_phone, password_hash, user_role_id, dealer_id, user_is_active_flag, user_is_locked_flag |
| `user_roles`        | role_id, role_name (ADMIN, DEALER, DISPATCHER, OFFICE_EXECUTIVE)      |
| `dealers`           | dealer_id, dealer_name, dealer_company_name, dealer_code, dealer_phone, dealer_email, location_id, dealer_daily_limit, dealer_monthly_target |
| `dealer_party`      | party_id, dealer_id, party_code, party_company_name, party_name, party_phone, party_address, party_email |
| `products`          | product_id, product_name, product_desc, product_is_active_flag        |
| `locations`         | location_id, location_name, location_desc                             |
| `code_reference`    | code_type, code, code_label, code_desc, code_sort_order (e.g. loading_type, loading_location) |
| `dealer_orders`     | order_id, dealer_id, product_id, order_quantity, party_id, load_type_code, preferred_location_code, order_status, order_date |
| `order_dispatch`    | dispatch_id, order_id, dispatch_vehicle_number, driver_id, created_at |
| `user_login_audit`  | login_audit_id, login_user_id, login_method, login_status, login_at, logout_at, login_ip_address, login_is_active |

---

## Roles & Access

| Role              | Access                                                              |
|-------------------|---------------------------------------------------------------------|
| ADMIN             | Everything: master data, all orders, dispatch, users, audit         |
| OFFICE_EXECUTIVE  | Can create login users (signup page)                                |
| DISPATCHER        | View all orders (same as admin for orders)                          |
| DEALER            | Place orders, view own orders, live tracking                        |

---

## Order Status Flow

```
ORDER_PLACED ──► ACCEPTED ──► DISPATCHED
     ▲                ▼
     └── ON_HOLD ◄────┘   (DEALER/ADMIN can put on hold from ORDER_PLACED or ACCEPTED)
```
Valid transitions defined in `routes/orders.js:VALID_TRANSITIONS`.

---

## Key Architectural Patterns

### Dynamic column detection
Every route that queries the DB first checks `information_schema.columns` for optional columns before building SQL. This avoids migration failures when schema evolves. Cached in module-level Maps.

### Session-based auth
- `req.session.user` holds `{ id, username, user_login_name, email, role, dealer_id }`
- Global middleware redirects unauthenticated GETs to `/signin` (except `/`, `/signin`, `/health`)
- API routes (`/api/*`) skip the redirect — callers get a 401/403 JSON response

### Account lockout
After 5 consecutive failed password attempts (tracked in session + global Map + `user_login_audit`), `user_is_locked_flag` is set to TRUE. Admin must unlock manually.

### Driver tracking (no auth)
`/driver/track` is intentionally public — the link is shared with the driver via SMS/WhatsApp. The driver page pushes GPS coordinates to Firebase Realtime Database. The `/tracking` page (auth required) reads those coordinates and renders on Google Maps.

### OTP sign-in
Currently **disabled** — `/request-otp` and `/verify-otp` return 403. The SMS service abstraction (dev/MSG91/Twilio) is wired but the routes are blocked.

---

## Environment Variables (`.env`)

```
PORT=3000 (local) / 8080 (AWS EB)
DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME / DB_SSL — local PG
DATABASE_URL — AWS RDS connection string (takes priority over fields above)
DB_SSL_REJECT_UNAUTHORIZED
DB_POOL_MAX / DB_IDLE_TIMEOUT_MS / DB_CONNECTION_TIMEOUT_MS
SESSION_SECRET
FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_DATABASE_URL / FIREBASE_PROJECT_ID ...
GOOGLE_MAPS_API_KEY
FIREBASE_TRACKING_PATH_PREFIX (default: driver_locations)
SMS_PROVIDER (dev | msg91 | twilio)
MSG91_AUTH_KEY / MSG91_TEMPLATE_ID / MSG91_SENDER_ID
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
```

---

## Deployment

- **Local dev**: `npm run dev` (nodemon, port 3000)
- **Production**: AWS Elastic Beanstalk, port 8080, listens on `0.0.0.0`
- **DB**: AWS RDS PostgreSQL in ap-south-1; `global-bundle.pem` present for SSL
- **Health check**: `GET /health` → 200 OK (no auth, used by EB load balancer)

---

## BRD v1.1 — Feature Gap Analysis

### Legend: ✅ Built | ⚠️ Partial | ❌ Not built | 🔧 DB change needed

---

### Dealer Module (Section 3)

| Feature | Status | Notes |
|---------|--------|-------|
| Product dropdown | ✅ | From `odts.products` |
| **No of bags field** | ❌🔧 | BRD requires bags input; quantity = bags × 50kg auto-calculated in MT |
| Party name dropdown + free text | ✅ | `dealer_party` table |
| Delivery address auto-populate from party | ✅ | `party_address` |
| Contact number auto-populate from party | ✅ | `party_phone` |
| Save new party address/phone for future | ✅ | POST `/api/dealer/parties` |
| Loading Type dropdown | ✅ | `code_reference` type=`loading_type` |
| Preferred Loading Location dropdown | ✅ | `code_reference` type=`loading_location` |
| Dealer dashboard: last T-2 days default | ⚠️ | Date filter exists but T-2 default not enforced |
| **Remaining limit display** | ❌ | `dealer_daily_limit` exists but not subtracted from placed orders |
| **Dealer limit enforcement** (block order if exceeds) | ❌ | Limit field exists but not validated on order placement |
| **80% limit alert → notify admin** | ❌ | Not implemented |
| **Admin contact number in config/master** | ❌🔧 | Need `system_config` table; dealer can call admin from order screen |
| On Hold: dealer can hold ORDER_PLACED only | ✅ | VALID_TRANSITIONS |
| **On Hold reason stored** | ❌🔧 | `dealer_orders` needs `on_hold_reason`, `on_hold_by`, `on_hold_by_role` columns |
| **On Hold ownership** (dealer hold ≠ admin hold) | ❌ | Same status, no way to distinguish who held |
| Released from ON_HOLD → ORDER_PLACED + reset order_date | ⚠️ | Status reverts but order_date not reset |
| Dispatch details with driver click-to-call | ⚠️ | Driver phone shown, but no `<a href="tel:">` link |
| Historical orders with date range | ✅ | Start/end date filter |
| **Historical days limit from master table (30 days)** | ❌ | Hardcoded |
| **Order execution time calculated** | ❌ | Not tracked |
| **Dealer display name** (not dealer_name) | ❌🔧 | BRD notes pending DB update — need `dealer_display_name` column |

---

### Dispatch Module (Section 4)

| Feature | Status | Notes |
|---------|--------|-------|
| View ORDER_PLACED and ACCEPTED orders | ✅ | Current orders view |
| **Hide ON_HOLD and DISPATCHED by default** | ❌ | Currently shows all |
| **Group orders by dealer, ascending time** | ❌ | Flat list only |
| Dispatcher: change ORDER_PLACED → ACCEPTED | ✅ | PATCH status endpoint |
| **Bilty Number field** | ❌🔧 | `order_dispatch` needs `bilty_number` column |
| **Actual Loading Location** (Rake/Godown/Plant) | ❌🔧 | `order_dispatch` needs `actual_loading_location_code` column |
| Vehicle Number | ✅ | `dispatch_vehicle_number` in `order_dispatch` |
| Driver Phone Number | ⚠️ | `driver_id` stored but no direct phone field in dispatch |
| Dispatch Time auto-populated | ✅ | `created_at` |
| **File upload for dispatch receipt** | ❌ | Not implemented |
| **Upload receipt later (same day)** | ❌ | Not implemented |
| ACCEPTED → DISPATCHED on submit | ✅ | Status transition |

---

### Admin Module (Section 5)

| Feature | Status | Notes |
|---------|--------|-------|
| **Report Dashboard: Monthly/Quarterly dealer targets** | ❌ | Not implemented |
| **Dealer drill-down with order details** | ❌ | Orders shown flat, not per-dealer drill-down |
| **Admin put order ON_HOLD with mandatory reason** | ❌🔧 | Reason field not in DB; reason types: Payment, Party request, Others |
| **Admin hold cannot be overridden by Dealer** | ❌ | No ownership tracking |
| Historical orders with date filter | ✅ | |
| Block/Unblock users (active/locked flags) | ✅ | |
| Update dealer limits | ✅ | `dealer_daily_limit`, `dealer_monthly_target` |
| **Bulk update dealer limits via Excel upload** | ❌ | Not implemented |
| **Create order on dealer's behalf** | ❌ | Not implemented |
| **Export orders/status/dispatch to Excel/CSV** | ⚠️ | XLSX library loaded in UI but full export not wired |

---

### Office Executive Module (Section 6)

| Feature | Status | Notes |
|---------|--------|-------|
| Create login users | ✅ | `/signup` (Admin + Office Executive) |
| **Dedicated Office dashboard** (same as Admin view) | ❌ | Currently Office Executive only sees generic dashboard |
| **Office can hold orders with mandatory reason** | ❌ | |
| **Create order on dealer's behalf** | ❌ | |
| **Export feature** | ❌ | |

---

### Sales Officer Module (Section 7 — marked Pending in BRD)

| Feature | Status | Notes |
|---------|--------|-------|
| SALES_OFFICER role in DB | ❌🔧 | Role not seeded |
| Read-only view of all orders, dealer-wise, T-2 days | ❌ | |
| View execution time | ❌ | |
| Real-time tracking (view only) | ❌ | |

---

### DB Schema Changes Required (before feature work)

| Table | Column(s) to Add | Reason |
|-------|-----------------|--------|
| `dealer_orders` | `order_bags` INT | No of bags input from BRD |
| `dealer_orders` | `on_hold_reason` TEXT | Hold reason |
| `dealer_orders` | `on_hold_by` INT (user_id) | Who put on hold |
| `dealer_orders` | `on_hold_by_role` VARCHAR | 'DEALER' or 'ADMIN'/'OFFICE_EXECUTIVE' |
| `dealer_orders` | `order_executed_at` TIMESTAMP | Order execution time |
| `dealers` | `dealer_display_name` VARCHAR | Display name separate from dealer_name |
| `order_dispatch` | `bilty_number` VARCHAR | Transport receipt number |
| `order_dispatch` | `actual_loading_location_code` VARCHAR | Actual vs preferred loading location |
| `order_dispatch` | `dispatch_receipt_path` VARCHAR | File upload path |
| `order_dispatch` | `driver_phone` VARCHAR | Direct phone on dispatch record |
| `system_config` | New table: `config_key`, `config_value` | Admin phone, history days limit, 80% threshold, etc. |
