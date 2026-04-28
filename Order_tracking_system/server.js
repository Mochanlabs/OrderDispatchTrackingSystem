const express = require('express');
require('dotenv').config();
const session = require('express-session');
const path = require('path');
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const dealerRoutes = require('./routes/dealers');
const partyRoutes = require('./routes/party');
const masterUserRoutes = require('./routes/masterUsers');
const userRoleRoutes = require('./routes/userRoles');
const orderRoutes = require('./routes/orders');
const trackingRoutes = require('./routes/tracking');
const driverRoutes = require('./routes/driver');
const auditRoutes = require('./routes/audit');
const codeReferenceRoutes = require('./routes/codeReference');
const dispatcherRoutes = require('./routes/dispatcher');
const pool = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret_in_prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Make session user available in all EJS templates as `user`
app.use((req, res, next) => {
  res.locals.user = req.session && req.session.user ? req.session.user : null;
  next();
});

// Public access policy:
// - Unauthenticated users can access only signin (and health/static assets)
// - Any other page route redirects to /signin
app.use((req, res, next) => {
  const hasSessionUser = !!(req.session && req.session.user);
  if (hasSessionUser) return next();

  const pathName = req.path || '/';
  const isApiRoute = pathName.startsWith('/api/');
  const isPublicRoute = pathName === '/' || pathName === '/signin' || pathName === '/health' || pathName === '/favicon.ico';

  if (!isApiRoute && req.method === 'GET' && !isPublicRoute) {
    return res.redirect('/signin');
  }

  return next();
});

app.use('/', authRoutes);
app.use('/', productRoutes);
app.use('/', dealerRoutes);
app.use('/', partyRoutes);
app.use('/', masterUserRoutes);
app.use('/', userRoleRoutes);
app.use('/', orderRoutes);
app.use('/', trackingRoutes);
app.use('/', driverRoutes);
app.use('/', auditRoutes);
app.use('/', codeReferenceRoutes);
app.use('/', dispatcherRoutes);

// Test DB connection and list users (tries schema `odts.users` first)
app.get('/users', async (req, res) => {
  try {
    let result;
    try {
      result = await pool.query('SELECT * FROM odts.users');
    } catch (e) {
      // fallback to public.users
      result = await pool.query('SELECT * FROM users');
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching users');
  }
});

//const PORT = process.env.PORT || 3000;
//app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
