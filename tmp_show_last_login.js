const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('lego.db');
const email = process.argv[2] || 'testci bot@example.test';

db.get("SELECT id, email, last_login FROM users WHERE email = ?", [email], (e, row) => {
  if (e) { console.error('DB ERR', e); process.exit(1); }
  if (!row) { console.log('No user found for', email); process.exit(0); }
  const raw = row.last_login;
  const formatted = raw ? new Date(raw).toISOString() : null;
  console.log(JSON.stringify({ id: row.id, email: row.email, last_login_raw: raw, last_login_iso: formatted }, null, 2));
  db.close();
});
