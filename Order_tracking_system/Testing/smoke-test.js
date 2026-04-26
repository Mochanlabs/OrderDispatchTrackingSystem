require('dotenv').config();
const http = require('http');
const qs   = require('querystring');

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  // 1. Login
  const loginBody = qs.stringify({ email: 'admin@odts.com', password: 'Admin@123' });
  const loginRes  = await request({
    hostname: 'localhost', port: 3000, path: '/signin', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginBody) }
  }, loginBody);

  const cookie = (loginRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log(`Login          → ${loginRes.status} (${loginRes.status === 302 ? '✅ OK' : '❌ FAIL'})`);

  // 2. Test all pages and APIs
  const routes = [
    ['GET', '/dashboard'],
    ['GET', '/master/products'],
    ['GET', '/master/locations'],
    ['GET', '/master/dealers'],
    ['GET', '/master/users'],
    ['GET', '/master/user_roles'],
    ['GET', '/api/products'],
    ['GET', '/api/locations'],
    ['GET', '/api/dealers'],
    ['GET', '/api/users'],
    ['GET', '/api/user_roles'],
  ];

  for (const [method, path] of routes) {
    const res = await request({
      hostname: 'localhost', port: 3000, path, method,
      headers: { Cookie: cookie }
    });
    const ok = [200, 201].includes(res.status);
    let detail = '';
    if (path.startsWith('/api/')) {
      try { const rows = JSON.parse(res.body); detail = ` (${Array.isArray(rows) ? rows.length + ' rows' : JSON.stringify(rows).slice(0,60)})`; } catch {}
    }
    console.log(`${method} ${path.padEnd(25)} → ${res.status} ${ok ? '✅' : '❌'}${detail}`);
    if (!ok && res.body) console.log('   Error:', res.body.replace(/<[^>]+>/g,'').trim().slice(0,200));
  }
}

run().catch(e => { console.error(e.message); process.exit(1); });
