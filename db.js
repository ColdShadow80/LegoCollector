const sqlite3 = require('sqlite3').verbose();

// 1. LIGAR À BASE DE DADOS CORRETA (lego.db)
const db = new sqlite3.Database('./lego.db', (err) => {
    if (err) console.error("Erro ao abrir base de dados:", err.message);
    else console.log("💾 Base de dados 'lego.db' ligada com sucesso.");
});

// FUNÇÃO AUXILIAR DE MIGRAÇÃO
// Tenta adicionar uma coluna. Se já existir, ignora o erro silenciosamente.
function addColumn(table, columnDef) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`, (err) => {
        if (err && !err.message.includes("duplicate column name")) {
            // Se o erro NÃO for "coluna duplicada", então é um erro real.
            console.error(`Erro ao migrar ${table}:`, err.message);
        } else if (!err) {
            console.log(`✨ Coluna adicionada: ${table} -> ${columnDef.split(' ')[0]}`);
        }
    });
}

db.serialize(() => {
    // --- 1. CRIAR TABELAS (Se não existirem) ---

    db.run(`CREATE TABLE IF NOT EXISTS user_share_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        token TEXT UNIQUE,
        type TEXT CHECK(type IN ('OWNED','WANTED','BOTH')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        last_used DATETIME,
        is_revoked INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        last_login DATETIME,
        is_admin INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sets (
        set_num TEXT PRIMARY KEY,
        name TEXT,
        year INTEGER,
        theme_id INTEGER,
        num_parts INTEGER,
        img_url TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY,
        name TEXT,
        parent_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_sets (
        user_id INTEGER,
        set_num TEXT,
        quantity INTEGER DEFAULT 1,
        status TEXT DEFAULT 'OWNED',
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, set_num),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (set_num) REFERENCES sets(set_num)
    )`);

    // NOVA TABELA V11 (Scanner)
    db.run(`CREATE TABLE IF NOT EXISTS barcodes (
        code TEXT PRIMARY KEY,
        set_num TEXT
    )`);

    // --- 2. MIGRAÇÕES (Adicionar colunas que faltam em tabelas antigas) ---
    
    // Tabela USERS
    addColumn('users', 'is_admin INTEGER DEFAULT 0');
    addColumn('users', 'google_id TEXT');
    addColumn('users', 'is_verified INTEGER DEFAULT 0');
    addColumn('users', 'verify_token TEXT');
    addColumn('users', 'reset_token TEXT');
    addColumn('users', 'reset_expires INTEGER');
    addColumn('users', 'dark_mode INTEGER DEFAULT 0');
    addColumn('users', 'items_per_page INTEGER DEFAULT 25');

    // Tabela SETS
    addColumn('sets', "eol_status TEXT DEFAULT 'Active'");
    addColumn('sets', 'price_eur REAL DEFAULT 0');
    addColumn('sets', 'is_hidden INTEGER DEFAULT 0');
    addColumn('sets', 'ignore_parts INTEGER DEFAULT 0');

    // Tabela THEMES
    addColumn('themes', 'is_hidden INTEGER DEFAULT 0');
    addColumn('themes', 'ignore_parts INTEGER DEFAULT 0');

    // Tabela USER_SETS
    addColumn('user_sets', "build_status TEXT DEFAULT 'Montado'");
    addColumn('user_sets', 'location TEXT');
    addColumn('user_sets', 'purchase_price REAL DEFAULT 0');

    // --- 3. CREATE INDEXES (Performance Critical) ---
    // Index for theme filtering
    db.run(`CREATE INDEX IF NOT EXISTS idx_sets_theme_id ON sets(theme_id)`, (err) => {
        if (!err) console.log("✨ Index created: sets(theme_id)");
    });
    
    // Index for year filtering and sorting
    db.run(`CREATE INDEX IF NOT EXISTS idx_sets_year ON sets(year)`, (err) => {
        if (!err) console.log("✨ Index created: sets(year)");
    });
    
    // Index for search (name and set_num searches)
    db.run(`CREATE INDEX IF NOT EXISTS idx_sets_name ON sets(name)`, (err) => {
        if (!err) console.log("✨ Index created: sets(name)");
    });
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_sets_set_num ON sets(set_num)`, (err) => {
        if (!err) console.log("✨ Index created: sets(set_num)");
    });
    
    // Index for user_sets lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_sets_user ON user_sets(user_id, status)`, (err) => {
        if (!err) console.log("✨ Index created: user_sets(user_id, status)");
    });
    
    // Index for barcode lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_sets_set ON user_sets(set_num)`, (err) => {
        if (!err) console.log("✨ Index created: user_sets(set_num)");
    });
});

module.exports = db;
