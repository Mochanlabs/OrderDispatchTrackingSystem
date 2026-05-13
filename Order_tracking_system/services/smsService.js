/**
 * SMS OTP Service
 *
 * Supports two modes via .env:
 *   SMS_PROVIDER=dev      → logs OTP to server console only (no real SMS)
 *   SMS_PROVIDER=msg91    → sends via MSG91 API (Indian gateway)
 *   SMS_PROVIDER=twilio   → sends via Twilio
 *
 * Required .env keys per provider:
 *   MSG91  : MSG91_AUTH_KEY, MSG91_TEMPLATE_ID, MSG91_SENDER_ID
 *   Twilio : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 */

require('dotenv').config();
const https = require('https');

const PROVIDER = (process.env.SMS_PROVIDER || 'dev').toLowerCase();

/**
 * Send OTP via MSG91
 * Docs: https://docs.msg91.com/reference/send-otp
 */
async function sendViaMSG91(phone, otp) {
  const authKey    = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const senderId   = process.env.MSG91_SENDER_ID || 'OTSMSG';

  if (!authKey || !templateId) {
    throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID must be set in .env');
  }

  // MSG91 expects 12-digit number: 91XXXXXXXXXX
  const intlPhone = phone.startsWith('91') ? phone : `91${phone}`;

  const payload = JSON.stringify({
    template_id: templateId,
    sender: senderId,
    short_url: '0',
    mobiles: intlPhone,
    otp
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'control.msg91.com',
      path: '/api/v5/otp',
      method: 'POST',
      headers: {
        'authkey': authKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'success') return resolve(parsed);
          return reject(new Error(`MSG91 error: ${data}`));
        } catch {
          return reject(new Error(`MSG91 bad response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send OTP via Twilio
 */
async function sendViaTwilio(phone, otp) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER must be set in .env');
  }

  const intlPhone = phone.startsWith('+') ? phone : `+91${phone}`;
  const body = `Your Order Tracking OTP is ${otp}. Valid for 5 minutes.`;
  const postData = new URLSearchParams({ To: intlPhone, From: from, Body: body }).toString();

  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.sid) return resolve(parsed);
          return reject(new Error(`Twilio error: ${data}`));
        } catch {
          return reject(new Error(`Twilio bad response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Main export – call this from routes/auth.js
 * Returns { success: true, devOtp? } where devOtp is only present in dev mode
 */
async function sendOtp(phone, otp) {
  if (PROVIDER === 'dev') {
    console.log(`\n[SMS DEV MODE] OTP for ${phone}: ${otp} (expires in 5 min)\n`);
    return { success: true, devOtp: otp };
  }

  if (PROVIDER === 'msg91') {
    await sendViaMSG91(phone, otp);
    return { success: true };
  }

  if (PROVIDER === 'twilio') {
    await sendViaTwilio(phone, otp);
    return { success: true };
  }

  throw new Error(`Unknown SMS_PROVIDER: ${PROVIDER}. Use 'dev', 'msg91', or 'twilio'`);
}

/**
 * Send custom alert message to phone
 * Used for business alerts (order limit notifications, etc)
 */
async function sendAlert(phone, message) {
  if (PROVIDER === 'dev') {
    console.log(`\n[SMS ALERT DEV MODE] ${phone}: ${message}\n`);
    return { success: true };
  }

  if (PROVIDER === 'msg91') {
    const authKey = process.env.MSG91_AUTH_KEY;
    const senderId = process.env.MSG91_SENDER_ID || 'ODTS';

    if (!authKey) throw new Error('MSG91_AUTH_KEY must be set in .env');

    const intlPhone = phone.startsWith('91') ? phone : `91${phone}`;
    const payload = JSON.stringify({
      sender: senderId,
      route: '4',
      country: '91',
      sms: [{ message, to: intlPhone }]
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.msg91.com',
        path: `/api/v5/sms/send?authkey=${authKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'success' || parsed.message === 'success') return resolve({ success: true });
            return reject(new Error(`MSG91 error: ${data}`));
          } catch {
            return reject(new Error(`MSG91 bad response: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  if (PROVIDER === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!accountSid || !authToken || !from) {
      throw new Error('Twilio credentials must be set in .env');
    }

    const intlPhone = phone.startsWith('+') ? phone : `+91${phone}`;
    const postData = new URLSearchParams({ To: intlPhone, From: from, Body: message }).toString();

    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const req = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.sid) return resolve({ success: true });
            return reject(new Error(`Twilio error: ${data}`));
          } catch {
            return reject(new Error(`Twilio bad response: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  throw new Error(`Unknown SMS_PROVIDER: ${PROVIDER}. Use 'dev', 'msg91', or 'twilio'`);
}

/**
 * Send WhatsApp message via Twilio
 * Used for admin notifications to dealers
 */
async function sendWhatsAppMessage(phone, message) {
  if (PROVIDER === 'dev') {
    console.log(`\n[WHATSAPP DEV MODE] ${phone}: ${message}\n`);
    return { success: true, status: 'sent', message_sid: 'DEV_' + Date.now() };
  }

  if (PROVIDER === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // Twilio sandbox or your number

    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env for WhatsApp');
    }

    const to = phone.startsWith('whatsapp:') ? phone : `whatsapp:+91${phone}`;
    const postData = new URLSearchParams({
      From: from,
      To: to,
      Body: message
    }).toString();

    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const req = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.sid) {
              return resolve({
                success: true,
                status: 'sent',
                message_sid: parsed.sid
              });
            }
            return reject(new Error(`Twilio WhatsApp error: ${data}`));
          } catch {
            return reject(new Error(`Twilio WhatsApp bad response: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  throw new Error(`WhatsApp not supported for SMS_PROVIDER: ${PROVIDER}. Use 'dev' or 'twilio'`);
}

module.exports = { sendOtp, sendAlert, sendWhatsAppMessage };
