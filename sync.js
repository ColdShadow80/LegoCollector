require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

// CONFIGURAÇÃO: Ano de corte para atualizações frequentes
const MIN_YEAR = 2026; 

async function syncSets(year) {
    console.log(`\n📡 A sincronizar sets de ${year}...`);
    
    // 1. Diagnóstico: Quantos sets "incompletos" existem localmente?
    let incompleteBefore = 0;
    try {
        const row = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM sets WHERE year = ? AND num_parts = 0", [year], (err, row) => {
                if(err) reject(err); else resolve(row);
            });
        });
        incompleteBefore = row ? row.count : 0;
        if (incompleteBefore > 0) {
            console.log(`   ⚠️ Encontrados ${incompleteBefore} sets locais com 0 peças. À procura de dados oficiais...`);
        }
    } catch (e) { console.error("Erro diagnóstico inicial:", e.message); }

    // 2. Loop na API
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let totalProcessed = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, {
                headers: { 'Authorization': `key ${API_KEY}` }
            });

            // 3. Upsert (Transação)
            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) DO UPDATE SET 
                            name = excluded.name, 
                            img_url = excluded.img_url, 
                            num_parts = excluded.num_parts, -- Atualiza nº de peças
                            theme_id = excluded.theme_id
                    `);

                    res.data.results.forEach(set => {
                        if (set.set_num && set.name) {
                            stmt.run(
                                set.set_num, 
                                set.name, 
                                set.year, 
                                set.theme_id, 
                                set.num_parts, 
                                set.set_img_url
                            );
                        }
                    });

                    stmt.finalize();
                    db.run("COMMIT", (err) => {
                        if(err) reject(err); else resolve();
                    });
                });
            });

            totalProcessed += res.data.results.length;
            nextUrl = res.data.next;
            if (nextUrl) process.stdout.write(".");
        }

        // 4. Relatório Final
        const rowAfter = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM sets WHERE year = ? AND num_parts = 0", [year], (err, row) => resolve(row));
        });
        
        const resolvedCount = incompleteBefore - (rowAfter ? rowAfter.count : 0);
        
        console.log(`\n✅ Ano ${year} concluído: ${totalProcessed} sets processados.`);
        if (resolvedCount > 0) {
            console.log(`✨ SUCESSO: ${resolvedCount} sets corrigidos (de 0 para nº real de peças)!`);
        }

    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.error("\n⚠️ Rate Limit da API atingido. Tentar novamente mais tarde.");
        } else {
            console.error(`\n❌ Erro crítico em ${year}:`, error.message);
        }
    }
}

// Execução
(async () => {
    const currentYear = new Date().getFullYear(); 
    // Verifica 2026 e 2027
    for (let y = MIN_YEAR; y <= currentYear + 1; y++) {
        await syncSets(y);
    }
    console.log("🏁 Sincronização terminada.");
})();
