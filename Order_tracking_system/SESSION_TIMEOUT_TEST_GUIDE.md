# Auto-Logout Session Timeout — Testing Guide

## Configuration ✅

- **Default Timeout**: 8 hours (28,800 seconds)
- **Configurable via**: `SESSION_TIMEOUT_HOURS` environment variable
- **Implementation**: Express-session with `touch: true` for inactivity tracking
- **Applies to**: All user roles (ADMIN, DEALER, DISPATCHER, OFFICE_EXECUTIVE, SALES_OFFICER)

---

## How It Works

### Session Behavior
```
User Login (8-hour timer starts)
    ↓
User Activity (ANY request resets timer)
    ↓
8 hours of NO activity → Session expires
    ↓
Next page load → Redirected to /signin
```

### Real-World Scenarios

| Scenario | Result |
|----------|--------|
| User active, making requests every hour | ✅ Stays logged in indefinitely |
| User inactive for 8 hours straight | ❌ Auto-logged out |
| User closes browser, reopens after 8+ hours | ❌ Auto-logged out (cookie expired) |
| User makes 1 request after 7.5 hours | ✅ Timer resets, stays logged in |

---

## Quick Test (2-Minute Timeout)

### Setup
```bash
# Start server with 2-minute timeout instead of 8 hours
SESSION_TIMEOUT_HOURS=0.033 npm run dev
```

### Test Steps

**1. Login Test**
- [ ] Open http://localhost:3000/signin
- [ ] Sign in with any user (ADMIN, DEALER, DISPATCHER, etc.)
- [ ] ✅ You should be logged in and see the dashboard

**2. Inactivity Test**
- [ ] Note the current time
- [ ] Wait 2-3 minutes WITHOUT doing anything
- [ ] Click any page (Orders, Dashboard, etc.)
- [ ] ✅ Should be redirected to /signin with session expired

**3. Activity Reset Test**
- [ ] Sign in again
- [ ] Every 1 minute, click something (view orders, refresh page, etc.)
- [ ] Keep active for 5 minutes
- [ ] ✅ Should stay logged in (timer keeps resetting)

**4. Browser Close Test**
- [ ] Sign in
- [ ] Note the time
- [ ] Close browser completely
- [ ] Wait 3 minutes
- [ ] Reopen browser and go to http://localhost:3000/dashboard
- [ ] ✅ Should be redirected to /signin (session cookie expired)

---

## Full Test (8-Hour Timeout)

### For Development/Staging Only
```bash
npm run dev
# Uses default SESSION_TIMEOUT_HOURS=8
```

### Monitoring Session Expiry
You can check session expiry by:

**1. Browser DevTools**
- Open DevTools (F12)
- Go to Application → Cookies
- Find `connect.sid` cookie
- Check "Expires/Max-Age" value

**2. Server Logs** (if enhanced logging is enabled)
- Look for: `[Orders] Processing X orders...`
- Sessions are touched on every request

### Test All User Roles

Test the timeout with each role:

```
✅ ADMIN
- Route: /master/dealers → any admin page
- Verify: After 8 hours of inactivity → /signin

✅ DEALER
- Route: /orders
- Verify: After 8 hours of inactivity → /signin

✅ DISPATCHER
- Route: /dispatcher
- Verify: After 8 hours of inactivity → /signin

✅ OFFICE_EXECUTIVE
- Route: /office/dashboard
- Verify: After 8 hours of inactivity → /signin

✅ SALES_OFFICER
- Route: /sales/dashboard
- Verify: After 8 hours of inactivity → /signin
```

---

## Session Timeout Indicator

Users can see the session timeout in the **navbar dropdown**:

```
👤 username [ROLE]
   ├─ username
   ├─ ⏱️ Auto logout after 8 hours of inactivity
   └─ 🚪 Sign out
```

---

## Production Deployment (AWS EB)

### Verify Timeout is Set
```bash
# Check environment variable
aws elasticbeanstalk describe-configuration-settings \
  --environment-name your-env-name \
  --application-name your-app \
  | grep SESSION_TIMEOUT_HOURS
```

### Change Timeout on Production
```bash
# Update the AWS Parameter Store value
aws ssm put-parameter \
  --name /odts/prod/SESSION_TIMEOUT_HOURS \
  --value "8" \
  --type "String" \
  --region ap-south-1 \
  --overwrite

# Redeploy application to load new value
```

---

## Troubleshooting

### Users Not Getting Logged Out After 8 Hours

**Check:**
1. ✅ Is `SESSION_TIMEOUT_HOURS` set correctly?
   ```bash
   echo $SESSION_TIMEOUT_HOURS
   ```

2. ✅ Are users making requests every few hours?
   - Each request resets the timer
   - If they're active, they won't be logged out

3. ✅ Browser storing cookies properly?
   - Check DevTools → Application → Cookies
   - Verify `connect.sid` exists and has an expiry

### Users Getting Logged Out Too Quickly

**Check:**
1. ✅ Is `SESSION_TIMEOUT_HOURS` value correct?
   - Default is 8 hours
   - If set to < 1, it might be in minutes instead

2. ✅ Is the session configuration using correct maxAge?
   - Should be: `SESSION_TIMEOUT_HOURS * 60 * 60 * 1000` (milliseconds)

---

## Expected Behavior Checklist

- [ ] ✅ User logs in → Session created with 8-hour expiry
- [ ] ✅ User inactive for 8 hours → Session expires
- [ ] ✅ User makes a request after 7 hours → Session resets, stays logged in
- [ ] ✅ User closes browser → Cookie expires after 8 hours
- [ ] ✅ All user roles are affected equally
- [ ] ✅ Navbar shows "Auto logout after 8 hours of inactivity"
- [ ] ✅ Expired session redirects to /signin

---

## Notes

- **Cookie**: `connect.sid` stores the session ID
- **Storage**: Express-session default (memory) - fine for development
- **Production**: Consider using session store (Redis, PostgreSQL) for persistence across restarts
- **Security**: Presigned URLs (24 hours) are independent of session timeout
