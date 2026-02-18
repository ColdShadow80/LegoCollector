const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('lego.db');
const email = process.argv[2] || 'testci bot@example.test';
db.run("UPDATE users SET is_verified = 1 WHERE email = ?", [email], function(e){ if(e) { console.error('ERR', e); process.exit(1); } console.log('OK'); db.close(); });
