require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const RB_API_KEY = process.env.REBRICKABLE_API_KEY;
const BS_API_KEY = process.env.BRICKSET_API_KEY;
const CURRENT_YEAR = new Date().getFullYear();
const START_YEAR = 2020; // 🎯 O seu filtro de ano

// --- 1. Sincronizar Sets do Rebrickable ---
async function syncRebrickable(year) {
    console.log(`\n📦 [Rebrickable] A verificar sets de ${year}...`);
    let nextUrl = `https://rebrickable.com/api/v3/lego/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let count = 0;
    let newSets = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${RB_API_KEY}` }});
            
            await new Promise(resolve => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    // Atualiza dados básicos, mas mantém o preço e estado de utilizador
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
                            stmt.run(s.set_num, s.name, s.year, s.theme_id, s.num_parts, s.set_img_url, function() {
                                if (this.changes > 0) newSets++;
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
        console.log(`\n✅ [Rebrickable] ${year}: ${count} analisados.`);
    } catch (e) { 
        console.error(`\n❌ [Rebrickable] Erro ${year}:`, e.message); 
    }
}

// --- 2. Sincronizar Preços do Brickset (FILTRO >= 2020) ---
async function syncBricksetPrices() {
    if (!BS_API_KEY) {
        console.log("⚠️ [Brickset] API Key em falta. A saltar preços.");
        return;
    }

    console.log(`\n💰 [Brickset] A procurar sets sem preço desde ${START_YEAR}...`);

    // QUERY FILTRADA: Só sets >= 2020 sem preço
    const setsToUpdate = await new Promise((resolve, reject) => {
        db.all(
            "SELECT set_num FROM sets WHERE (price_eur IS NULL OR price_eur = 0) AND year >= ?", 
            [START_YEAR], 
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });

    if (setsToUpdate.length === 0) {
        console.log("✅ [Brickset] Nada a atualizar.");
        return;
    }

    console.log(`📋 [Brickset] Encontrados ${setsToUpdate.length} sets recentes sem preço.`);

    // Lotes de 20 (limite seguro da API)
    const CHUNK_SIZE = 20;
    
    for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
        const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE).map(s => s.set_num);
        const query = chunk.join(',');

        try {
            const params = JSON.stringify({ setNumber: query });
            // URL CORRIGIDO (brickset.com direto)
            const url = `https://brickset.com/api/v3.asmx/getSets?apiKey=${BS_API_KEY}&userHash=&params=${encodeURIComponent(params)}`;
            
            const response = await axios.get(url);
            let updatedCount = 0;

            if (response.data && response.data.sets) {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    const stmt = db.prepare("UPDATE sets SET price_eur = ? WHERE set_num = ?");

                    response.data.sets.forEach(bSet => {
                        // Prioridade: Alemanha (DE) -> França (FR) -> Zero
                        let price = null;
                        if (bSet.LEGOCom && bSet.LEGOCom.DE) price = bSet.LEGOCom.DE.retailPrice;
                        else if (bSet.LEGOCom && bSet.LEGOCom.FR) price = bSet.LEGOCom.FR.retailPrice;
                        
                        if (price) {
                            const setNum = `${bSet.number}-${bSet.numberVariant}`;
                            stmt.run(price, setNum);
                            updatedCount++;
                        }
                    });
                    stmt.finalize();
                    db.run("COMMIT");
                });
                process.stdout.write(`+${updatedCount} `); // Feedback visual
            }
        } catch (e) {
            process.stdout.write("X"); // Erro no lote
        }

        // Pausa de cortesia (1s)
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log("\n✅ [Brickset] Preços atualizados.");
}

// --- FLUXO PRINCIPAL ---
(async () => {
    // 1. Sincronizar Sets (Ano a Ano, desde 2020 até ao próximo ano)
    console.log("🚀 A INICIAR SINCRONIZAÇÃO (Modo Económico: 2020+)...");
    
    for (let y = START_YEAR; y <= CURRENT_YEAR + 1; y++) {
        await syncRebrickable(y);
    }

    // 2. Buscar Preços (Apenas para o que foi sincronizado acima e não tem preço)
    await syncBricksetPrices();

    console.log("\n🏁 Sincronização terminada.");
})();
