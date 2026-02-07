const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lego_tracker.db');

db.serialize(() => {
    // Tabela de Utilizadores
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

    // Tabela de Sets
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

    // Tabela de Temas
    db.run(`CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY,
        name TEXT,
        parent_id INTEGER,
        is_hidden INTEGER DEFAULT 0,
        ignore_parts INTEGER DEFAULT 0
    )`);

    // Tabela de Coleção (User <-> Sets)
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

    // NOVA TABELA (V11.2): Aprendizagem de Barcodes
    db.run(`CREATE TABLE IF NOT EXISTS barcodes (
        code TEXT PRIMARY KEY,
        set_num TEXT
    )`);
});

module.exports = db;
