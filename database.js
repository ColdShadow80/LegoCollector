const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lego.db');

db.serialize(() => {
    // Tabela de Sets
    db.run(`CREATE TABLE IF NOT EXISTS sets (
        set_num TEXT PRIMARY KEY,
        name TEXT,
        year INTEGER,
        theme_id INTEGER,
        num_parts INTEGER,
        img_url TEXT,
        eol_status TEXT DEFAULT 'Active', 
        eol_date TEXT,
        price_eur REAL,
        owned INTEGER DEFAULT 0
    )`);

    // Tabela de Temas
    db.run(`CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY,
        name TEXT,
        parent_id INTEGER
    )`);
});

module.exports = db;
