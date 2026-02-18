// test_user_features.js
// Usage: node test_user_features.js
// This script logs in as a regular user and tests account features: share, import, export.

const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookie = require('fetch-cookie');
const jar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, jar);

const BASE = 'http://localhost:3000';
const USER_EMAIL = 'user@user.com';
const USER_PASS = 'userpass';

async function login() {
  await fetchWithCookies(BASE + '/login');
  const res = await fetchWithCookies(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(USER_EMAIL)}&password=${encodeURIComponent(USER_PASS)}`,
    redirect: 'manual',
  });
  if (res.status === 302) {
    console.log('✅ User login successful');
    return true;
  } else {
    console.error('❌ User login failed:', res.status, await res.text());
    return false;
  }
}

async function testExport() {
  const res = await fetchWithCookies(BASE + '/account/export');
  if (res.status === 200) {
    const data = await res.json();
    console.log('✅ Export collection:', Array.isArray(data.sets) ? 'OK' : 'Not OK');
  } else {
    console.error('❌ Export failed:', res.status);
  }
}

async function testShare() {
  const res = await fetchWithCookies(BASE + '/account/share/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'BOTH' })
  });
  const data = await res.json();
  if (data.success && data.token) {
    console.log('✅ Share link created:', data.token);
    // Test public access
    const pubRes = await fetch(BASE + '/share/' + data.token);
    if (pubRes.status === 200) {
      console.log('✅ Public share link accessible');
    } else {
      console.error('❌ Public share link failed:', pubRes.status);
    }
  } else {
    console.error('❌ Share link creation failed');
  }
}

async function testImport() {
  // Prepare fake collection
  const fakeSets = [{ set_num: '1234', status: 'OWNED', quantity: 1 }];
  const blob = Buffer.from(JSON.stringify(fakeSets));
  const formData = new (require('form-data'))();
  formData.append('file', blob, { filename: 'import.json', contentType: 'application/json' });
  const res = await fetchWithCookies(BASE + '/account/import', {
    method: 'POST',
    body: formData,
    headers: formData.getHeaders()
  });
  const data = await res.json();
  if (data.success) {
    console.log('✅ Import collection succeeded');
  } else {
    console.error('❌ Import collection failed');
  }
}

(async () => {
  if (await login()) {
    await testExport();
    await testShare();
    await testImport();
  } else {
    process.exit(1);
  }
})();
