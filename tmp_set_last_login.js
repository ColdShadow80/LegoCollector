const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('lego.db');
const id = process.argv[2] || 2;
const now = Date.now();
db.run("UPDATE users SET last_login = ? WHERE id = ?", [now, id], function(e){ if(e) console.error('ERR', e); else console.log('OK', now); db.close();});
