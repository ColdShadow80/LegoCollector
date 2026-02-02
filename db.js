const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('./lego.db');

// --- SISTEMA DE MIGRAÇÕES ---
const MIGRATIONS = [
    // Versão 1: Estrutura Base (O que você já tem)
    `CREATE TABLE IF NOT EXISTS sets (
        set_num TEXT PRIMARY KEY, name TEXT, year INTEGER, theme_id INTEGER, 
        num_parts INTEGER, img_url TEXT, eol_status TEXT DEFAULT 'Active', 
        eol_date TEXT, price_eur REAL, owned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER
    );`,

    // Versão 2: Multi-Utilizador (Novas Tabelas)
    `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE, password TEXT, name TEXT, google_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS user_sets (
        user_id INTEGER, set_num TEXT, date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, set_num),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(set_num) REFERENCES sets(set_num)
    );
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);`
];

function runMigrations() {
    db.serialize(() => {
        // 1. Verifica se a tabela de versão existe
        db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)", (err) => {
            if (err) console.error(err);
            
            // 2. Obtém a versão atual
            db.get("SELECT version FROM schema_version", async (err, row) => {
                let currentVersion = row ? row.version : 0;
                console.log(`📊 Base de dados na versão: ${currentVersion}`);

                // 3. Aplica migrações pendentes
                if (currentVersion < MIGRATIONS.length) {
                    console.log("🔄 Iniciando atualização da base de dados...");
                    
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        
                        for (let i = currentVersion; i < MIGRATIONS.length; i++) {
                            console.log(`   > Aplicando migração versão ${i + 1}...`);
                            // Executa cada comando SQL da migração (separados por ;)
                            const commands = MIGRATIONS[i].split(';').filter(cmd => cmd.trim() !== '');
                            commands.forEach(command => db.run(command));
                            
                            // Migração Especial de Dados (V1 -> V2)
                            // Se tinhamos sets marcados como 'owned' na tabela antiga, 
                            // vamos prepará-los para mover para o user_sets depois (lógica manual)
                        }

                        // Atualiza versão
                        db.run("DELETE FROM schema_version");
                        db.run("INSERT INTO schema_version (version) VALUES (?)", [MIGRATIONS.length]);
                        
                        db.run("COMMIT", () => console.log("✅ Base de dados atualizada com sucesso!"));
                    });
                }
            });
        });
    });
}

// Inicializa
runMigrations();

module.exports = db;
