require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const RB_API_KEY = process.env.REBRICKABLE_API_KEY;
const BS_API_KEY = process.env.BRICKSET_API_KEY;
const CURRENT_YEAR = new Date().getFullYear();

// --- 1. FUNÇÕES DO REBRICKABLE (SETS) ---

async function syncRebrickable(year) {
    console.log(`\n📦 [Rebrickable] A sincronizar sets de ${year}...`);
    let nextUrl = `https://rebrickable.com/api/v3/lego/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let count = 0;

    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${RB_API_KEY}` }});
            
            await new Promise(resolve => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    
                    // Se for ano atual, atualiza tudo (pode haver correções de imagens/nomes)
                    // Se for antigo, só insere se não existir ou atualiza se tiver 0 peças (dados em falta)
                    const conflictClause = (year >= CURRENT_YEAR) 
                        ? `DO UPDATE SET name=excluded.name, img_url=excluded.img_url, num_parts=excluded.num_parts, theme_id=excluded.theme_id`
                        : `DO UPDATE SET num_parts=excluded.num_parts, img_url=excluded.img_url WHERE sets.num_parts = 0`;

                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) ${conflictClause}
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
            process.stdout.write("."); 
        }
        console.log(`\n✅ [Rebrickable] ${year}: ${count} sets processados.`);
    } catch (e) { 
        console.error(`\n❌ [Rebrickable] Erro ${year}:`, e.message); 
    }
}

// --- 2. FUNÇÕES DO BRICKSET (PREÇOS) ---

async function syncBricksetPrices() {
    if (!BS_API_KEY) {
        console.log("⚠️ [Brickset] API Key em falta. A saltar sincronização de preços.");
        return;
    }

    console.log("\n💰 [Brickset] A verificar sets sem preço...");

    // Buscar sets que não têm preço (ou preço é 0)
    const setsToUpdate = await new Promise((resolve, reject) => {
        db.all("SELECT set_num FROM sets WHERE price_eur IS NULL OR price_eur = 0", [], (err, rows) => {
            if (err) reject(err); else resolve(rows);
        });
    });

    if (setsToUpdate.length === 0) {
        console.log("✅ [Brickset] Todos os preços estão atualizados.");
        return;
    }

    console.log(`📋 [Brickset] ${setsToUpdate.length} sets precisam de preço. A iniciar download...`);

    // Processar em lotes de 20 (limite seguro da API)
    const CHUNK_SIZE = 20;
    
    for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
        const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE).map(s => s.set_num);
        const query = chunk.join(','); // Brickset pede "75000-1,75001-1"

        try {
            // URL OFICIAL CORRIGIDO
            const params = JSON.stringify({ setNumber: query });
            const url = `https://brickset.com/api/v3.asmx/getSets?apiKey=${BS_API_KEY}&userHash=&params=${encodeURIComponent(params)}`;
            
            const response = await axios.get(url);
            
            if (response.data && response.data.sets) {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    const stmt = db.prepare("UPDATE sets SET price_eur = ? WHERE set_num = ?");

                    response.data.sets.forEach(bSet => {
                        // Tenta obter preço DE (Alemanha) -> Referência Euro
                        let price = null;
                        if (bSet.LEGOCom && bSet.LEGOCom.DE) price = bSet.LEGOCom.DE.retailPrice;
                        
                        if (price) {
                            const setNum = `${bSet.number}-${bSet.numberVariant}`;
                            stmt.run(price, setNum);
                        }
                    });
                    stmt.finalize();
                    db.run("COMMIT");
                });
                process.stdout.write("€");
            }
        } catch (e) {
            process.stdout.write("X"); // Erro no lote
        }

        // Pausa pequena para não sobrecarregar
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("\n✅ [Brickset] Sincronização de preços concluída.");
}

// --- FLUXO PRINCIPAL ---

(async () => {
    // 1. Sincronizar Novos Sets (Ano Corrente + Próximo + Anterior)
    const years = [CURRENT_YEAR, CURRENT_YEAR + 1, CURRENT_YEAR - 1];
    
    console.log("🚀 A INICIAR SINCRONIZAÇÃO TOTAL...");
    
    for (let y of years) {
        await syncRebrickable(y);
    }

    // 2. Sincronizar Preços (Preenche o que falta em TODA a coleção, não só nestes anos)
    await syncBricksetPrices();

    console.log("\n🏁 Processo terminado com sucesso.");
})();
