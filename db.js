const sqlite3 = require('sqlite3').verbose();

// Ligar à base de dados original (lego.db)
const db = new sqlite3.Database('./lego.db', (err) => {
    if (err) {
        console.error("❌ Erro ao abrir base de dados:", err.message);
    } else {
        console.log("💾 Ligado com sucesso à base de dados 'lego.db'.");
    }
});

/**
 * Função Auxiliar para Migração de Colunas
 * Tenta adicionar uma coluna e ignora se ela já existir.
 */
function addColumn(table, columnDef) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`, (err) => {
        if (err) {
            if (err.message.includes("duplicate column name")) {
                // Silencioso: A coluna já existe, não é necessário fazer nada.
            } else {
                console.error(`⚠️ Erro na migração (${table}): ${err.message}`);
            }
        } else {
            console.log(`✨ Nova coluna adicionada: ${table} (${columnDef.split(' ')[0]})`);
        }
    });
}

db.serialize(() => {
    // --- 1. CRIAÇÃO DE TABELAS BASE (Se não existirem) ---

    // Utilizadores
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        google_id TEXT,
        is_verified INTEGER DEFAULT 0,
        verify_token TEXT,
        reset_token TEXT,
        reset_expires INTEGER,
        last_login DATETIME,
        dark_mode INTEGER DEFAULT 0,
        items_per_page INTEGER DEFAULT 25
    )`);

    // Sets (Catálogo Geral)
    db.run(`CREATE TABLE IF NOT EXISTS sets (
        set_num TEXT PRIMARY KEY,
        name TEXT,
        year INTEGER,
        theme_id INTEGER,
        num_parts INTEGER,
        img_url TEXT,
        eol_status TEXT DEFAULT 'Active',
        price_eur REAL DEFAULT 0,
        is_hidden INTEGER DEFAULT 0,
        ignore_parts INTEGER DEFAULT 0
    )`);

    // Temas
    db.run(`CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY,
        name TEXT,
        parent_id INTEGER,
        is_hidden INTEGER DEFAULT 0,
        ignore_parts INTEGER DEFAULT 0
    )`);

    // Inventário do Utilizador (Relacionamento N:M)
    db.run(`CREATE TABLE IF NOT EXISTS user_sets (
        user_id INTEGER,
        set_num TEXT,
        quantity INTEGER DEFAULT 1,
        status TEXT DEFAULT 'OWNED',
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        build_status TEXT DEFAULT 'Montado',
        location TEXT,
        purchase_price REAL DEFAULT 0,
        PRIMARY KEY (user_id, set_num),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (set_num) REFERENCES sets(set_num)
    )`);

    // Memória do Scanner (Aprendizagem de Códigos de Barras)
    db.run(`CREATE TABLE IF NOT EXISTS barcodes (
        code TEXT PRIMARY KEY,
        set_num TEXT
    )`);

    // --- 2. MIGRAÇÕES AUTOMÁTICAS (Upgrade de Colunas) ---
    // Isto garante que bases de dados antigas recebem as funcionalidades novas
    
    // Migrações para 'users'
    addColumn('users', 'dark_mode INTEGER DEFAULT 0');
    addColumn('users', 'items_per_page INTEGER DEFAULT 25');
    addColumn('users', 'google_id TEXT');
    addColumn('users', 'is_verified INTEGER DEFAULT 0');
    
    // Migrações para 'themes'
    addColumn('themes', 'is_hidden INTEGER DEFAULT 0');
    addColumn('themes', 'ignore_parts INTEGER DEFAULT 0');

    // Migrações para 'sets'
    addColumn('sets', 'price_eur REAL DEFAULT 0');
    addColumn('sets', 'is_hidden INTEGER DEFAULT 0');
    addColumn('sets', 'ignore_parts INTEGER DEFAULT 0');

    // Migrações para 'user_sets'
    addColumn('user_sets', "build_status TEXT DEFAULT 'Montado'");
    addColumn('user_sets', 'location TEXT');
    addColumn('user_sets', 'purchase_price REAL DEFAULT 0');
});

module.exports = db;
