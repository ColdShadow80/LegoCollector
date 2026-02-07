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

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        last_login DATETIME
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
});

module.exports = db;
