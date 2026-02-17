const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('lego.db');
const email = process.argv[2] || 'testci+bot@example.test';
db.get("SELECT reset_token, reset_expires FROM users WHERE email = ?", [email], (e, r) => {
  if (e) { console.error('ERR', e); process.exit(1); }
  console.log(JSON.stringify(r));
  db.close();
});
