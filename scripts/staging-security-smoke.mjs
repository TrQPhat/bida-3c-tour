const baseUrl = String(process.env.STAGING_URL || '').replace(/\/$/, '');
const username = process.env.STAGING_TEST_USERNAME;
const password = process.env.STAGING_TEST_PASSWORD;
if (!baseUrl || !username || !password) {
  throw new Error('STAGING_URL, STAGING_TEST_USERNAME and STAGING_TEST_PASSWORD are required');
}

const checks = [];
const expect = (name, actual, expected) => {
  checks.push({ name, actual, expected });
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
};

const health = await fetch(`${baseUrl}/healthz`);
expect('health', health.status, 200);
const login = await fetch(`${baseUrl}/bff/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
});
expect('login', login.status, 200);
const sessionCookie = login.headers.getSetCookie?.().find((value) => value.startsWith('cue_session=')) || login.headers.get('set-cookie');
if (!sessionCookie) throw new Error('Login did not return the session cookie');
for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict']) {
  if (!sessionCookie.toLowerCase().includes(attribute.toLowerCase())) throw new Error(`Session cookie is missing ${attribute}`);
}
const cookie = sessionCookie.split(';', 1)[0];
const loginBody = await login.json();
if (loginBody.user?.role !== 'user') throw new Error('Staging test account must have role user');
const csrf = loginBody.csrf;

const me = await fetch(`${baseUrl}/bff/auth/me`, { headers: { cookie } });
expect('authenticated session', me.status, 200);
const adminRead = await fetch(`${baseUrl}/bff/users`, { headers: { cookie } });
expect('user cannot read admin data', adminRead.status, 403);
const missingCsrf = await fetch(`${baseUrl}/bff/teams`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
});
expect('missing CSRF is rejected', missingCsrf.status, 403);
const roleBypass = await fetch(`${baseUrl}/bff/teams`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
});
expect('user cannot mutate admin resource', roleBypass.status, 403);
const directApi = await fetch(`${baseUrl}/users`, { redirect: 'manual' });
if ([200, 201].includes(directApi.status) && (directApi.headers.get('content-type') || '').includes('application/json')) {
  throw new Error('Direct API path is publicly reachable');
}
const logout = await fetch(`${baseUrl}/bff/auth/logout`, {
  method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
});
expect('logout', logout.status, 200);

for (const check of checks) console.log(`PASS ${check.name}: ${check.actual}`);
console.log('STAGING SECURITY SMOKE OK');
