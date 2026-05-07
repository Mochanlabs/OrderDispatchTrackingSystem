const express = require('express');
const session = require('express-session');
const path = require('path');
const { loadParameters } = require('./config/parameterStore');
const { initializeS3 } = require('./services/s3Service');

// Load parameters from Parameter Store first, then start app
(async () => {
  try {
    await loadParameters();

    // Initialize S3 service
    // AWS SDK will use default credential chain:
    // 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
    // 2. AWS credentials file (~/.aws/credentials) — from `aws configure`
    // 3. AWS config file (~/.aws/config)
    // 4. IAM role (on EC2/EBS)
    const s3Config = {
      bucket: process.env.S3_BUCKET || process.env.AWS_S3_BUCKET_NAME || 'odts-dev-s3-receipt',
      region: process.env.AWS_REGION || process.env.AWS_S3_REGION || 'ap-south-1',
    };

    initializeS3(s3Config);

    // Now require routes and db (which depend on environment variables)
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

    const app = express();

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(express.json({ limit: '50mb' }));
    app.use(express.static(path.join(__dirname, 'public')));

    // Session timeout in hours (default: 8 hours)
    const SESSION_TIMEOUT_HOURS = parseInt(process.env.SESSION_TIMEOUT_HOURS || '8', 10);
    const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;

    app.use(session({
      secret: process.env.SESSION_SECRET || 'change_this_secret_in_dev',
      resave: false,
      saveUninitialized: false,
      touch: true, // Reset session timeout on each request (implements inactivity timeout)
      cookie: { maxAge: SESSION_TIMEOUT_MS }
    }));

    app.use((req, res, next) => {
      res.locals.user = req.session && req.session.user ? req.session.user : null;
      res.locals.sessionTimeoutHours = SESSION_TIMEOUT_HOURS;
      next();
    });

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

    app.get('/health', (req, res) => {
      res.status(200).send('OK');
    });

    // Global error handler for unhandled errors
    app.use((err, _req, res, _next) => {
      console.error('Unhandled error:', err);
      const isApiRoute = _req.path.startsWith('/api/');
      if (isApiRoute) {
        return res.status(500).json({ error: err.message || 'Internal server error' });
      }
      res.status(500).send('Internal server error');
    });

    // 404 handler
    app.use((_req, res) => {
      const isApiRoute = _req.path.startsWith('/api/');
      if (isApiRoute) {
        return res.status(404).json({ error: 'Endpoint not found' });
      }
      res.status(404).send('Not found');
    });

    const PORT = process.env.PORT || 8080;

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
})();
