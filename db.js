const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lego.db');

const MIGRATIONS = [
    // V1: Note que 'price_eur' já existe aqui (PVP Oficial)
    `CREATE TABLE IF NOT EXISTS sets (set_num TEXT PRIMARY KEY, name TEXT, year INTEGER, theme_id INTEGER, num_parts INTEGER, img_url TEXT, eol_status TEXT DEFAULT 'Active', eol_date TEXT, price_eur REAL DEFAULT 0, owned INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS themes (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER);`,
    // V2
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, name TEXT, google_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS user_sets (user_id INTEGER, set_num TEXT, date_added DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, set_num), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(set_num) REFERENCES sets(set_num));
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);`,
    // V3 a V6
    `ALTER TABLE users ADD COLUMN dark_mode INTEGER DEFAULT 0; ALTER TABLE users ADD COLUMN items_per_page INTEGER DEFAULT 25;`,
    `ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0; ALTER TABLE users ADD COLUMN verify_token TEXT; ALTER TABLE users ADD COLUMN reset_token TEXT; ALTER TABLE users ADD COLUMN reset_expires INTEGER;`,
    `ALTER TABLE themes ADD COLUMN is_hidden INTEGER DEFAULT 0; ALTER TABLE themes ADD COLUMN ignore_parts INTEGER DEFAULT 0; ALTER TABLE users ADD COLUMN last_login DATETIME;`,
    `ALTER TABLE sets ADD COLUMN is_hidden INTEGER DEFAULT 0; ALTER TABLE sets ADD COLUMN ignore_parts INTEGER DEFAULT 0;`,
    // V7 & V8
    `ALTER TABLE user_sets ADD COLUMN status TEXT DEFAULT 'OWNED'; ALTER TABLE user_sets ADD COLUMN quantity INTEGER DEFAULT 1;`,
    `ALTER TABLE user_sets ADD COLUMN build_status TEXT DEFAULT 'Montado'; ALTER TABLE user_sets ADD COLUMN location TEXT;`,
    // V9: Preço de Compra (Custo Pessoal)
    `ALTER TABLE user_sets ADD COLUMN purchase_price REAL DEFAULT 0;`
];

function runMigrations() {
    db.serialize(() => {
        db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)");
        db.get("SELECT version FROM schema_version", (err, row) => {
            let currentVersion = row ? row.version : 0;
            if (currentVersion < MIGRATIONS.length) {
                console.log(`🔄 A atualizar Base de Dados da v${currentVersion} para v${MIGRATIONS.length}...`);
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
                        console.log(`   > Aplicando migração v${i + 1}...`);
                        const commands = MIGRATIONS[i].split(';').filter(cmd => cmd.trim() !== '');
                        commands.forEach(command => {
                            db.run(command, (err) => { if(err && !err.message.includes('duplicate column')) console.log("Nota:", err.message); });
                        });
                    }
                    db.run("DELETE FROM schema_version");
                    db.run("INSERT INTO schema_version (version) VALUES (?)", [MIGRATIONS.length]);
                    db.run("COMMIT", () => console.log("✅ Base de dados atualizada!"));
                });
            }
        });
    });
}
runMigrations();
module.exports = db;
