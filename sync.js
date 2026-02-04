require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

// Obtém o ano atual do sistema (2026 no seu caso)
const CURRENT_YEAR = new Date().getFullYear();

// Função auxiliar para verificar se um ano precisa de reparação
// Retorna TRUE se existirem sets desse ano com 0 peças na BD local
async function checkYearNeedsRepair(year) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT COUNT(*) as count FROM sets WHERE year = ? AND num_parts = 0";
        db.get(sql, [year], (err, row) => {
            if (err) reject(err);
            // Se count > 0, significa que temos sets incompletos e precisamos de ir à API
            else resolve(row.count > 0);
        });
    });
}

async function syncSets(year) {
    console.log(`\n📡 A sincronizar SETS de ${year}...`);
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let count = 0;
    let newSets = 0;
    let updatedSets = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${API_KEY}` }});
            
            await new Promise(resolve => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    // QUERY INTELIGENTE:
                    // 1. Tenta Inserir (Se for novo)
                    // 2. Se já existe (Conflito), SÓ atualiza se o set local tiver 0 peças
                    //    (Exceto no ano corrente/futuro, onde atualizamos tudo pois imagens/nomes mudam muito)
                    const isVolatileYear = year >= CURRENT_YEAR;
                    
                    let conflictClause;
                    if (isVolatileYear) {
                        // Ano atual/futuro: Atualiza tudo (nomes, imagens, peças)
                        conflictClause = `
                            DO UPDATE SET 
                            name=excluded.name, 
                            img_url=excluded.img_url, 
                            num_parts=excluded.num_parts, 
                            theme_id=excluded.theme_id
                        `;
                    } else {
                        // Ano passado: Só atualiza se o nosso nº de peças for 0
                        conflictClause = `
                            DO UPDATE SET 
                            num_parts=excluded.num_parts,
                            img_url=excluded.img_url
                            WHERE sets.num_parts = 0
                        `;
                    }

                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) ${conflictClause}
                    `);

                    res.data.results.forEach(s => {
                        if(s.set_num && s.name) {
                            stmt.run(s.set_num, s.name, s.year, s.theme_id, s.num_parts, s.set_img_url, function(err) {
                                // this.changes dá-nos pistas se houve escrita
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
            process.stdout.write("."); // Feedback visual
        }
        console.log(`\n✅ ${year}: ${count} sets analisados.`);
    } catch (e) { 
        if(e.response && e.response.status === 429) console.error("\n⚠️ Rate Limit atingido.");
        else console.error(`\n❌ Erro ${year}:`, e.message); 
    }
}

// --- LOGICA PRINCIPAL DE DECISÃO ---
(async () => {
    const yearsToSync = [];

    // 1. Regra: Ano Atual e Próximo são OBRIGATÓRIOS 
    // (Para descobrir sets novos que não existem na BD)
    yearsToSync.push(CURRENT_YEAR);
    yearsToSync.push(CURRENT_YEAR + 1);

    // 2. Regra: Ano Anterior APENAS se houver dados em falta
    const prevYear = CURRENT_YEAR - 1;
    const needsRepair = await checkYearNeedsRepair(prevYear);
    
    if (needsRepair) {
        console.log(`🔍 Diagnóstico: Encontrados sets de ${prevYear} com 0 peças. A agendar atualização...`);
        yearsToSync.push(prevYear);
    } else {
        console.log(`⏭️ Diagnóstico: Todos os sets de ${prevYear} parecem completos. A saltar sincronização deste ano.`);
    }

    // 3. Execução
    // Ordena para ficar bonito no log (Ex: 2025, 2026, 2027)
    yearsToSync.sort();

    console.log(`📋 Plano de Sincronização: [ ${yearsToSync.join(', ')} ]`);

    for (let y of yearsToSync) {
        await syncSets(y);
    }
    
    console.log("🏁 Sincronização inteligente concluída.");
})();
