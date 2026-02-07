require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const RB_API_KEY = process.env.REBRICKABLE_API_KEY;
const BS_API_KEY = process.env.BRICKSET_API_KEY;
const CURRENT_YEAR = new Date().getFullYear();
const START_YEAR = 2020; // 🎯 Começa em 2020

// Função auxiliar para promessas de DB
const dbAll = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

// --- 1. Sincronizar Sets do Rebrickable ---
async function syncRebrickable(year) {
    console.log(`\n📦 [Rebrickable] A verificar sets de ${year}...`);
    let nextUrl = `https://rebrickable.com/api/v3/lego/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let count = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${RB_API_KEY}` }});
            
            await new Promise(resolve => {
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

                    res.data.results.forEach(s => {
                        if(s.set_num && s.name) {
                            stmt.run(s.set_num, s.name, s.year, s.theme_id, s.num_parts, s.set_img_url);
                        }
                    });
                    stmt.finalize();
                    db.run("COMMIT", resolve);
                });
            });
            count += res.data.results.length;
            nextUrl = res.data.next;
            // Feedback simples para rebrickable
            process.stdout.write("."); 
        }
        console.log(`\n✅ [Rebrickable] ${year}: ${count} sets analisados.`);
    } catch (e) { 
        console.error(`\n❌ [Rebrickable] Erro ${year}:`, e.message); 
    }
}

// --- 2. Sincronizar Preços do Brickset (Por Ano) ---
async function syncBricksetPricesForYear(year) {
    if (!BS_API_KEY) { console.log("⚠️ API Key em falta."); return; }

    // Buscar sets desse ano sem preço
    const setsToUpdate = await dbAll(
        "SELECT set_num FROM sets WHERE year = ? AND (price_eur IS NULL OR price_eur = 0)", 
        [year]
    );

    if (setsToUpdate.length === 0) {
        console.log(`🔹 [Brickset] ${year}: Tudo atualizado.`);
        return;
    }

    console.log(`💰 [Brickset] ${year}: A atualizar ${setsToUpdate.length} sets...`);

    const CHUNK_SIZE = 20;
    let processed = 0;
    let updatedTotal = 0;
    let errors = 0;

    for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
        const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE).map(s => s.set_num);
        const query = chunk.join(',');

        try {
            const params = JSON.stringify({ setNumber: query });
            const url = `https://brickset.com/api/v3.asmx/getSets?apiKey=${BS_API_KEY}&userHash=&params=${encodeURIComponent(params)}`;
            
            const response = await axios.get(url, { timeout: 10000 }); // Timeout de 10s para não pendurar

            if (response.data && response.data.sets) {
                let batchUpdates = 0;
                
                await new Promise(resolve => {
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        const stmt = db.prepare("UPDATE sets SET price_eur = ? WHERE set_num = ?");

                        response.data.sets.forEach(bSet => {
                            let price = null;
                            // Prioridade: DE -> FR -> US
                            if (bSet.LEGOCom && bSet.LEGOCom.DE) price = bSet.LEGOCom.DE.retailPrice;
                            else if (bSet.LEGOCom && bSet.LEGOCom.FR) price = bSet.LEGOCom.FR.retailPrice;
                            
                            if (price) {
                                // O Brickset retorna '75300' e '1', juntamos para '75300-1'
                                const setNum = `${bSet.number}-${bSet.numberVariant}`;
                                stmt.run(price, setNum);
                                batchUpdates++;
                            }
                        });
                        stmt.finalize();
                        db.run("COMMIT", resolve);
                    });
                });
                updatedTotal += batchUpdates;
            }
        } catch (e) {
            errors++;
            // Mostra erro apenas se for grave, senão continua
            // console.error(` Err: ${e.message}`); 
        }

        processed += chunk.length;
        
        // --- BARRA DE PROGRESSO VISUAL ---
        // \r faz o cursor voltar ao início da linha para sobrescrever o texto
        const percent = Math.round((processed / setsToUpdate.length) * 100);
        process.stdout.write(`\r   ⏳ Progresso: [ ${processed} / ${setsToUpdate.length} ] (${percent}%) - Atualizados: ${updatedTotal}`);

        // Pausa de cortesia (500ms) para não bloquear a API
        await new Promise(r => setTimeout(r, 500));
    }
    
    process.stdout.write("\n"); // Nova linha no fim do ano
    if (errors > 0) console.log(`   ⚠️ Houve ${errors} lotes com erro de conexão neste ano.`);
}

// --- FLUXO PRINCIPAL ---
(async () => {
    console.log(`🚀 A INICIAR (Anos: ${START_YEAR} a ${CURRENT_YEAR})...`);
    
    // Loop ano a ano
    for (let y = START_YEAR; y <= CURRENT_YEAR + 1; y++) {
        // 1. Sets
        await syncRebrickable(y);
        
        // 2. Preços (Imediatamente após os sets desse ano)
        await syncBricksetPricesForYear(y);
    }

    console.log("\n🏁 Sincronização terminada.");
})();
