require('dotenv').config();
const axios = require('axios');
const db = require('./db'); // Usa o seu gestor de DB atual

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

// CONFIGURAÇÃO: Foca a atualização apenas em sets recentes e futuros
// Isto garante que sets de 2026 com 0 peças sejam revistos diariamente
const MIN_YEAR = 2026; 

async function syncSets(year) {
    console.log(`\n📡 A sincronizar sets de ${year}...`);
    
    // 1. Antes de começar, conta quantos sets "incompletos" (0 peças) temos na BD para este ano
    let incompleteBefore = 0;
    try {
        const row = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM sets WHERE year = ? AND num_parts = 0", [year], (err, row) => {
                if(err) reject(err); else resolve(row);
            });
        });
        incompleteBefore = row.count;
        if (incompleteBefore > 0) {
            console.log(`   ⚠️ Detetados ${incompleteBefore} sets locais com 0 peças. À procura de atualizações...`);
        }
    } catch (e) { console.error("Erro ao verificar sets locais:", e.message); }

    // 2. Busca dados frescos da API
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let totalUpdated = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, {
                headers: { 'Authorization': `key ${API_KEY}` }
            });

            // Transaction para velocidade
            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) DO UPDATE SET 
                        name=excluded.name, 
                        img_url=excluded.img_url, 
                        num_parts=excluded.num_parts, -- AQUI: Garante que o nº peças é atualizado
                        theme_id=excluded.theme_id
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

            totalUpdated += res.data.results.length;
            nextUrl = res.data.next;
            if (nextUrl) console.log(`   ...a carregar mais páginas...`);
        }

        // 3. Relatório Pós-Sincronização
        const rowAfter = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM sets WHERE year = ? AND num_parts = 0", [year], (err, row) => resolve(row));
        });
        
        const resolved = incompleteBefore - rowAfter.count;
        console.log(`✅ ${year}: ${totalUpdated} sets processados.`);
        if (resolved > 0) {
            console.log(`✨ SUCESSO: ${resolved} sets que tinham 0 peças foram atualizados com o nº correto!`);
        }

    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.error("⚠️ Rate Limit da API atingido. O script tentará novamente amanhã.");
        } else {
            console.error(`❌ Erro ao sincronizar ${year}:`, error.message);
        }
    }
}

// Loop Principal
(async () => {
    const currentYear = new Date().getFullYear(); // 2026 no seu contexto
    
    // Sincroniza do ano definido (2026) até ao ano seguinte (2027) para apanhar leaks/pré-vendas
    for (let y = MIN_YEAR; y <= currentYear + 1; y++) {
        await syncSets(y);
    }
    
    console.log("🏁 Sincronização concluída.");
})();
