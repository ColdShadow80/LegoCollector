require('dotenv').config();
const axios = require('axios');
const db = require('./database');

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

// CONFIGURAÇÃO: Começar a buscar apenas a partir deste ano
const MIN_YEAR = 2026; 

async function syncSets(year) {
    console.log(`📡 A verificar API por novos sets de ${year}...`);
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=200`;

    try {
        // Loop para lidar com paginação da API (caso existam mais de 200 sets num ano)
        while (nextUrl) {
            const res = await axios.get(nextUrl, {
                headers: { 'Authorization': `key ${API_KEY}` }
            });

            // Prepara a transação para ser rápido
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                
                const stmt = db.prepare(`
                    INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                    VALUES (?, ?, ?, ?, ?, ?, 'Active')
                    ON CONFLICT(set_num) DO UPDATE SET 
                    name=excluded.name, 
                    img_url=excluded.img_url, 
                    num_parts=excluded.num_parts
                `);

                res.data.results.forEach(set => {
                    // Só atualizamos/inserimos se tivermos dados válidos
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
                db.run("COMMIT");
            });

            // Passa para a próxima página da API (se houver)
            nextUrl = res.data.next;
            if (nextUrl) console.log(`   ...a carregar mais páginas de ${year}`);
        }
        console.log(`✅ Sets de ${year} sincronizados com sucesso.`);
        
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.error("⚠️ Limite da API atingido (Rate Limit). Tente mais tarde.");
        } else {
            console.error(`❌ Erro ao sincronizar ${year}:`, error.message);
        }
    }
}

(async () => {
    const currentYear = new Date().getFullYear();
    const startYear = MIN_YEAR;
    
    // Sincroniza do ano definido (2026) até ao ano seguinte (para apanhar pré-lançamentos)
    // Como estamos em 2026, ele vai verificar 2026 e 2027.
    for (let y = startYear; y <= currentYear + 1; y++) {
        await syncSets(y);
    }
    
    console.log("🏁 Sincronização incremental concluída.");
})();
