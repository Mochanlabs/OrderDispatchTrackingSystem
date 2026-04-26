const express = require('express');
const router = express.Router();

function ensureTrackingUser(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/signin');
  const role = req.session.user.role;
  if (role !== 'DEALER' && role !== 'ADMIN' && role !== 'DISPATCHER') {
    return res.status(403).send('Access denied.');
  }
  return next();
}

router.get('/tracking', ensureTrackingUser, (req, res) => {
  res.render('tracking/index', {
    user: req.session.user,
    defaultDriverPhone: req.query.driver || '',
    defaultOrderId: req.query.order || ''
  });
});

router.get('/api/tracking/config', ensureTrackingUser, (req, res) => {
  res.json({
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
      databaseURL: process.env.FIREBASE_DATABASE_URL || '',
      projectId: process.env.FIREBASE_PROJECT_ID || '',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID || ''
    },
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    trackingPathPrefix: process.env.FIREBASE_TRACKING_PATH_PREFIX || 'driver_locations'
  });
});

module.exports = router;
