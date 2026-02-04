const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lego.db');

// --- SISTEMA DE MIGRAÇÕES ---
// Cada entrada no array é uma versão da base de dados.
const MIGRATIONS = [
    // V1: Estrutura Base
    `CREATE TABLE IF NOT EXISTS sets (
        set_num TEXT PRIMARY KEY, name TEXT, year INTEGER, theme_id INTEGER, 
        num_parts INTEGER, img_url TEXT, eol_status TEXT DEFAULT 'Active', 
        eol_date TEXT, price_eur REAL, owned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER
    );`,

    // V2: Multi-Utilizador
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
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);`,

    // V3: Preferências de Utilizador (Modo Escuro e Paginação)
    `ALTER TABLE users ADD COLUMN dark_mode INTEGER DEFAULT 0;
     ALTER TABLE users ADD COLUMN items_per_page INTEGER DEFAULT 25;`
    	
    // V4: SEGURANÇA E EMAIL (NOVO)
    `ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0;
     ALTER TABLE users ADD COLUMN verify_token TEXT;
     ALTER TABLE users ADD COLUMN reset_token TEXT;
     ALTER TABLE users ADD COLUMN reset_expires INTEGER;` 
];

function runMigrations() {
    db.serialize(() => {
        // 1. Garante que a tabela de versão existe
        db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)", (err) => {
            if (err) console.error(err);
            
            // 2. Verifica versão atual
            db.get("SELECT version FROM schema_version", async (err, row) => {
                let currentVersion = row ? row.version : 0;
                
                if (currentVersion < MIGRATIONS.length) {
                    console.log(`🔄 A atualizar Base de Dados da v${currentVersion} para v${MIGRATIONS.length}...`);
                    
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        
                        for (let i = currentVersion; i < MIGRATIONS.length; i++) {
                            console.log(`   > Aplicando migração v${i + 1}...`);
                            // Separa comandos por ponto e vírgula se houver múltiplos numa string
                            const commands = MIGRATIONS[i].split(';').filter(cmd => cmd.trim() !== '');
                            commands.forEach(command => {
                                // Ignora erros de "coluna já existe" se rodar multiplas vezes
                                db.run(command, (err) => { 
                                    if(err && !err.message.includes('duplicate column')) console.log("Nota:", err.message); 
                                });
                            });
                        }

                        // Atualiza a versão final
                        db.run("DELETE FROM schema_version");
                        db.run("INSERT INTO schema_version (version) VALUES (?)", [MIGRATIONS.length]);
                        
                        db.run("COMMIT", () => console.log("✅ Base de dados atualizada!"));
                    });
                }
            });
        });
    });
}

// Executa migrações ao iniciar
runMigrations();

module.exports = db;
