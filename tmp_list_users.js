const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('lego.db');
db.all("SELECT id,email,reset_token,reset_expires FROM users WHERE email LIKE '%testci%'", [], (e, rows) => {
  if (e) { console.error('ERR', e); process.exit(1); }
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
