// test_admin_themes.js
// Usage: node test_admin_themes.js
// This script logs in as admin and tests the /admin/themes page for key features.

const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookie = require('fetch-cookie');
const jar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, jar);

const BASE = 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@admin.com';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || 'admin';

async function login() {
  // Get login page to get session cookie
  await fetchWithCookies(BASE + '/login');
  // Post login
  const res = await fetchWithCookies(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(ADMIN_EMAIL)}&password=${encodeURIComponent(ADMIN_PASS)}`,
    redirect: 'manual',
  });
  if (res.status === 302 && res.headers.get('location') === '/admin') {
    console.log('✅ Login successful');
    return true;
  } else {
    console.error('❌ Login failed:', res.status, await res.text());
    return false;
  }
}

async function testThemesPage() {
  const res = await fetchWithCookies(BASE + '/admin/themes');
  const html = await res.text();
  if (res.status !== 200) {
    console.error('❌ /admin/themes not accessible:', res.status);
    return;
  }
  // Check for new features
  const checks = [
    { label: 'Coluna Peças', pattern: /<th[^>]*>Peças<\/th>/ },
    { label: 'Coluna Atualização Peças', pattern: /Atualização Peças/ },
    { label: 'Botão Editar', pattern: /btn-outline-primary"[^>]*>Editar/ },
    { label: 'Toggle Esconder', pattern: /form-check-input[^>]*type="checkbox"[^>]*onchange="toggle/ },
    { label: 'Modal Novo Tema', pattern: /id="newThemeModal"/ },
    { label: 'Campo ID único', pattern: /id="newThemeId"/ },
    { label: 'Bulk update', pattern: /arrow-repeat/ },
  ];
  let allOk = true;
  for (const check of checks) {
    if (check.pattern.test(html)) {
      console.log('✅', check.label);
    } else {
      console.error('❌', check.label);
      allOk = false;
    }
  }
  if (allOk) {
    console.log('🎉 All admin themes features found!');
  }
}

(async () => {
  if (await login()) {
    await testThemesPage();
  } else {
    process.exit(1);
  }
})();
