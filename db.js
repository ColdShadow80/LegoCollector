const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lego.db');

db.serialize(() => {
    // Tabelas Base
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        email TEXT UNIQUE, 
        password TEXT, 
        google_id TEXT, 
        is_verified INTEGER DEFAULT 0, 
        dark_mode INTEGER DEFAULT 0, 
        items_per_page INTEGER DEFAULT 25
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sets (
        set_num TEXT PRIMARY KEY, 
        name TEXT, 
        year INTEGER, 
        theme_id INTEGER, 
        num_parts INTEGER, 
        img_url TEXT, 
        price_eur REAL DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY, 
        name TEXT, 
        is_hidden INTEGER DEFAULT 0, 
        ignore_parts INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_sets (
        user_id INTEGER, 
        set_num TEXT, 
        status TEXT, 
        location TEXT, 
        build_status TEXT, 
        purchase_price REAL DEFAULT 0,
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, set_num)
    )`);

    // Tabela para o Scanner AI memorizar associações manuais
    db.run(`CREATE TABLE IF NOT EXISTS barcodes (code TEXT PRIMARY KEY, set_num TEXT)`);
    
    // Migrações Silenciosas para temas e colunas novas
    db.run(`ALTER TABLE themes ADD COLUMN is_hidden INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE themes ADD COLUMN ignore_parts INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN dark_mode INTEGER DEFAULT 0`, (err) => {});
});

module.exports = db;
