require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';
const CURRENT_YEAR = new Date().getFullYear();

// Função auxiliar: Só pede reparação se existirem sets com 0 peças 
// que NÃO estejam num tema ignorado E que NÃO estejam marcados para ignorar individualmente
async function checkYearNeedsRepair(year) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT COUNT(*) as count 
            FROM sets 
            JOIN themes ON sets.theme_id = themes.id
            WHERE sets.year = ? 
            AND sets.num_parts = 0 
            AND (themes.ignore_parts IS NULL OR themes.ignore_parts = 0)
            AND (sets.ignore_parts IS NULL OR sets.ignore_parts = 0)
        `;
        
        db.get(sql, [year], (err, row) => {
            if (err) reject(err);
            else resolve(row.count > 0);
        });
    });
}

async function syncSets(year) {
    console.log(`\n📡 A sincronizar SETS de ${year}...`);
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let count = 0;
    let updatedSets = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${API_KEY}` }});
            
            await new Promise(resolve => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    const isVolatileYear = year >= CURRENT_YEAR;
                    let conflictClause;
                    
                    if (isVolatileYear) {
                        conflictClause = `DO UPDATE SET name=excluded.name, img_url=excluded.img_url, num_parts=excluded.num_parts, theme_id=excluded.theme_id`;
                    } else {
                        // Só atualiza passados se tiver 0 peças E não estiver marcado para ignorar
                        conflictClause = `
                            DO UPDATE SET num_parts=excluded.num_parts, img_url=excluded.img_url 
                            WHERE sets.num_parts = 0 AND (sets.ignore_parts IS NULL OR sets.ignore_parts = 0)
                        `;
                    }

                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) ${conflictClause}
                    `);

                    res.data.results.forEach(s => {
                        if(s.set_num && s.name) {
                            stmt.run(s.set_num, s.name, s.year, s.theme_id, s.num_parts, s.set_img_url, function() {
                                if (this.changes > 0) updatedSets++; 
                            });
                        }
                    });
                    stmt.finalize();
                    db.run("COMMIT", resolve);
                });
            });
            count += res.data.results.length;
            nextUrl = res.data.next;
            process.stdout.write("."); 
        }
        console.log(`\n✅ ${year}: ${count} sets analisados.`);
    } catch (e) { 
        if(e.response && e.response.status === 429) console.error("\n⚠️ Rate Limit atingido.");
        else console.error(`\n❌ Erro ${year}:`, e.message); 
    }
}

(async () => {
    const yearsToSync = [];
    yearsToSync.push(CURRENT_YEAR);
    yearsToSync.push(CURRENT_YEAR + 1);

    const prevYear = CURRENT_YEAR - 1;
    const needsRepair = await checkYearNeedsRepair(prevYear);
    
    if (needsRepair) {
        console.log(`🔍 Diagnóstico: Encontrados sets de ${prevYear} incompletos e válidos.`);
        yearsToSync.push(prevYear);
    } else {
        console.log(`⏭️ Diagnóstico: ${prevYear} ignorado (completo ou excluído).`);
    }

    yearsToSync.sort();
    console.log(`📋 Plano: [ ${yearsToSync.join(', ')} ]`);
    for (let y of yearsToSync) await syncSets(y);
    console.log("🏁 Sincronização inteligente concluída.");
})();
