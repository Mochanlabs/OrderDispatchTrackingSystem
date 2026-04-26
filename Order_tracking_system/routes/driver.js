const express = require('express');
const router = express.Router();

// Driver tracking page — no auth required (link shared with driver via SMS/WhatsApp)
router.get('/driver/track', (req, res) => {
  res.render('driver/track', {
    user: null,
    defaultPhone: req.query.phone || '',
    defaultOrder: req.query.order || '',
    defaultVehicle: req.query.vehicle || ''
  });
});

module.exports = router;
