require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const RB_API_KEY = process.env.REBRICKABLE_API_KEY;
const BS_API_KEY = process.env.BRICKSET_API_KEY;
const CURRENT_YEAR = new Date().getFullYear();
const START_YEAR = 2020; // Ano de início para a pesquisa de preços

// Função auxiliar para Promisify do db.all
const dbAll = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

// --- 1. SINCRONIZAR SETS (REBRICKABLE) ---
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
            process.stdout.write("."); // Feedback visual de progresso
        }
        console.log(`\n✅ [Rebrickable] ${year}: ${count} sets processados.`);
    } catch (e) { 
        console.error(`\n❌ [Rebrickable] Erro ${year}:`, e.message); 
    }
}

// --- 2. SINCRONIZAR PREÇOS (BRICKSET) ---
async function syncBricksetPricesForYear(year) {
    if (!BS_API_KEY) { 
        console.log("⚠️ [Brickset] API Key em falta. Ignorando preços."); 
        return; 
    }

    // Selecionar sets desse ano que não têm preço (ou preço é 0)
    const setsToUpdate = await dbAll(
        "SELECT set_num FROM sets WHERE year = ? AND (price_eur IS NULL OR price_eur = 0)", 
        [year]
    );

    if (setsToUpdate.length === 0) {
        console.log(`🔹 [Brickset] ${year}: Preços já estão atualizados.`);
        return;
    }

    console.log(`💰 [Brickset] ${year}: A procurar preços para ${setsToUpdate.length} sets...`);

    const CHUNK_SIZE = 20;
    let totalUpdated = 0;
    let processedCount = 0;

    for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
        // TRUQUE: Enviar apenas o número base (ex: "75300" em vez de "75300-1")
        // O Rebrickable guarda como "75300-1". O Brickset prefere receber "75300".
        const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE);
        
        // Cria um array só com os números base (ex: ['75300', '42115'])
        const baseNumbers = chunk.map(s => s.set_num.split('-')[0]);
        // Remove duplicados no pedido (caso existam variantes -1 e -2)
        const uniqueQuery = [...new Set(baseNumbers)].join(',');

        try {
            // Formatar parâmetros exatamente como a API v3 pede
            const params = JSON.stringify({ setNumber: uniqueQuery });
            const url = `https://brickset.com/api/v3.asmx/getSets?apiKey=${BS_API_KEY}&userHash=&params=${encodeURIComponent(params)}`;
            
            const response = await axios.get(url, { timeout: 15000 });

            if (response.data && response.data.sets && response.data.sets.length > 0) {
                let batchCount = 0;
                
                await new Promise(resolve => {
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        const stmt = db.prepare("UPDATE sets SET price_eur = ? WHERE set_num = ?");

                        response.data.sets.forEach(bSet => {
                            let price = null;
                            
                            // Lógica de Prioridade de Preço (Zona Euro)
                            if (bSet.LEGOCom) {
                                if (bSet.LEGOCom.DE) price = bSet.LEGOCom.DE.retailPrice;      // Alemanha (Melhor referência)
                                else if (bSet.LEGOCom.FR) price = bSet.LEGOCom.FR.retailPrice; // França
                                else if (bSet.LEGOCom.NL) price = bSet.LEGOCom.NL.retailPrice; // Holanda
                                else if (bSet.LEGOCom.US) price = bSet.LEGOCom.US.retailPrice; // Fallback USD (se quiser arriscar conversão, por agora assumimos 1:1 ou ignoramos)
                            }

                            if (price) {
                                // RECONSTRUÇÃO DO ID: Brickset devolve number="75300" e variant="1".
                                // Juntamos para formar "75300-1" e bater certo com a nossa BD.
                                const fullSetNum = `${bSet.number}-${bSet.numberVariant}`;
                                stmt.run(price, fullSetNum);
                                batchCount++;
                            }
                        });
                        stmt.finalize();
                        db.run("COMMIT", resolve);
                    });
                });
                totalUpdated += batchCount;
            } else {
                // Se a resposta for vazia, pode ser erro de formato ou sets não encontrados
                // console.log("   (Lote vazio ou sem correspondência)"); 
            }

        } catch (e) {
            console.error(`   ❌ Erro no lote: ${e.message}`);
        }

        // Atualizar barra de progresso
        processedCount += chunk.length;
        const percent = Math.round((processedCount / setsToUpdate.length) * 100);
        process.stdout.write(`\r   ⏳ Progresso: [ ${processedCount} / ${setsToUpdate.length} ] (${percent}%) - Preços Encontrados: ${totalUpdated}`);

        // Pausa de 1s para não bloquear a API
        await new Promise(r => setTimeout(r, 1000));
    }

    process.stdout.write("\n"); // Nova linha no fim do ano
}

// --- FLUXO PRINCIPAL ---
(async () => {
    console.log(`🚀 A INICIAR SYNC (Sets & Preços) - ${START_YEAR} a ${CURRENT_YEAR}...`);
    
    for (let y = START_YEAR; y <= CURRENT_YEAR + 1; y++) {
        // 1. Atualizar Lista de Sets
        await syncRebrickable(y);
        
        // 2. Atualizar Preços
        await syncBricksetPricesForYear(y);
    }

    console.log("\n🏁 Sincronização terminada com sucesso.");
})();
