require('dotenv').config();
const axios = require('axios');
const db = require('./db'); // Importa o gestor de base de dados partilhado

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

// CONFIGURAÇÃO:
// Define o ano a partir do qual queremos forçar a verificação.
// Sets anteriores a este ano raramente mudam, por isso focamos a API nas novidades.
const MIN_YEAR = 2026; 

async function syncSets(year) {
    console.log(`\n📡 A sincronizar sets de ${year}...`);
    
    // 1. Diagnóstico Inicial: Quantos sets temos com 0 peças antes de atualizar?
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

    // 2. Loop de Paginação da API
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let totalProcessed = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, {
                headers: { 'Authorization': `key ${API_KEY}` }
            });

            // 3. Inserção / Atualização em Massa (Transação)
            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    // QUERY DE UPSERT (Update or Insert)
                    // A parte mágica é o "ON CONFLICT": se o set já existe,
                    // forçamos a atualização do num_parts e outros dados vitais.
                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) DO UPDATE SET 
                            name = excluded.name, 
                            img_url = excluded.img_url, 
                            num_parts = excluded.num_parts, -- Garante que 0 passa para o nº real
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
            if (nextUrl) process.stdout.write("."); // Feedback visual de progresso
        }

        // 4. Relatório Final: Quantos foram corrigidos?
        const rowAfter = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM sets WHERE year = ? AND num_parts = 0", [year], (err, row) => resolve(row));
        });
        
        const resolvedCount = incompleteBefore - (rowAfter ? rowAfter.count : 0);
        
        console.log(`\n✅ Ano ${year} concluído: ${totalProcessed} sets processados.`);
        if (resolvedCount > 0) {
            console.log(`✨ SUCESSO: ${resolvedCount} sets que tinham 0 peças foram atualizados com a contagem correta!`);
        }

    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.error("\n⚠️ Rate Limit da API atingido. O script tentará novamente na próxima execução.");
        } else {
            console.error(`\n❌ Erro crítico ao sincronizar ${year}:`, error.message);
        }
    }
}

// Execução Principal
(async () => {
    const currentYear = new Date().getFullYear(); 
    
    // Verifica o ano definido (2026) e o próximo (2027) para apanhar leaks/futuros
    for (let y = MIN_YEAR; y <= currentYear + 1; y++) {
        await syncSets(y);
    }
    
    console.log("🏁 Processo de atualização terminado.");
})();
