const http = require('http');

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  // Sign in
  const login = await req(
    { host: 'localhost', port: 3000, path: '/signin', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    'email=admin%40odts.com&password=Admin%40123'
  );
  const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log('Login status:', login.status, '| Cookie set:', cookie.length > 10 ? 'YES' : 'NO');

  for (const p of ['/api/locations', '/api/dealers', '/api/products', '/api/user_roles', '/api/users']) {
    const r = await req({ host: 'localhost', port: 3000, path: p, method: 'GET', headers: { Cookie: cookie } });
    try {
      const data = JSON.parse(r.body || '[]');
      console.log(p + ' →', r.status, '| rows:', Array.isArray(data) ? data.length : JSON.stringify(data));
    } catch (e) {
      console.log(p + ' →', r.status, '| body:', r.body.slice(0, 100));
    }
  }
})().catch(e => console.error('ERROR:', e.message));
