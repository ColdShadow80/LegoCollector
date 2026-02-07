require('dotenv').config();
const axios = require('axios');
const db = require('./db');
const querystring = require('querystring'); // Nativo do Node.js

const RB_API_KEY = process.env.REBRICKABLE_API_KEY;
const BS_API_KEY = process.env.BRICKSET_API_KEY;
const CURRENT_YEAR = new Date().getFullYear();
const START_YEAR = 2020; 

// Função auxiliar DB
const dbAll = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

// --- 1. SETS (REBRICKABLE) ---
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
                        ON CONFLICT(set_num) DO UPDATE SET name=excluded.name, img_url=excluded.img_url, num_parts=excluded.num_parts
                    `);
                    res.data.results.forEach(s => { if(s.set_num) stmt.run(s.set_num, s.name, s.year, s.theme_id, s.num_parts, s.set_img_url); });
                    stmt.finalize();
                    db.run("COMMIT", resolve);
                });
            });
            count += res.data.results.length;
            nextUrl = res.data.next;
            process.stdout.write("."); 
        }
        console.log(`\n✅ [Rebrickable] ${year}: ${count} sets verificados.`);
    } catch (e) { console.error(`\n❌ [Rebrickable] Erro:`, e.message); }
}

// --- 2. PREÇOS (BRICKSET) - AGORA COM POST E DEBUG ---
async function syncBricksetPricesForYear(year) {
    if (!BS_API_KEY) return;

    // Buscar sets sem preço (NULL ou 0)
    const setsToUpdate = await dbAll(
        "SELECT set_num FROM sets WHERE year = ? AND (price_eur IS NULL OR price_eur = 0)", 
        [year]
    );

    if (setsToUpdate.length === 0) {
        console.log(`🔹 [Brickset] ${year}: Tudo atualizado.`);
        return;
    }

    console.log(`💰 [Brickset] ${year}: A procurar preços para ${setsToUpdate.length} sets...`);

    const CHUNK_SIZE = 20;
    let processedCount = 0;
    let totalUpdated = 0;

    for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
        const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE);
        // Remover variante "-1" para enviar ao Brickset
        const baseNumbers = chunk.map(s => s.set_num.split('-')[0]);
        const uniqueQuery = [...new Set(baseNumbers)].join(',');

        try {
            // USAR POST (Mais seguro para parâmetros JSON)
            const postBody = querystring.stringify({
                apiKey: BS_API_KEY,
                userHash: '',
                params: JSON.stringify({ setNumber: uniqueQuery })
            });

            const response = await axios.post('https://brickset.com/api/v3.asmx/getSets', postBody, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            });

            // --- DEBUG DO PRIMEIRO LOTE (Para vermos o erro) ---
            if (i === 0 && processedCount === 0) {
                console.log("\n--- DEBUG API BRICKSET (Primeiro Lote) ---");
                if (response.data.status !== 'success') {
                    console.log("STATUS:", response.data.status);
                    console.log("MESSAGE:", response.data.message);
                } else if (response.data.sets.length > 0) {
                    console.log("EXEMPLO DE RESPOSTA:", JSON.stringify(response.data.sets[0].LEGOCom, null, 2));
                } else {
                    console.log("⚠️ A API retornou sucesso, mas lista de sets vazia.");
                    console.log("Query enviada:", uniqueQuery);
                }
                console.log("------------------------------------------\n");
            }
            // ----------------------------------------------------

            if (response.data && response.data.sets) {
                let batchCount = 0;
                await new Promise(resolve => {
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        const stmt = db.prepare("UPDATE sets SET price_eur = ? WHERE set_num = ?");

                        response.data.sets.forEach(bSet => {
                            let price = null;

                            // VERIFICAÇÃO ROBUSTA DE PREÇO
                            if (bSet.LEGOCom) {
                                if (bSet.LEGOCom.DE) price = bSet.LEGOCom.DE.retailPrice;
                                else if (bSet.LEGOCom.FR) price = bSet.LEGOCom.FR.retailPrice;
                                else if (bSet.LEGOCom.ES) price = bSet.LEGOCom.ES.retailPrice;
                                else if (bSet.LEGOCom.IT) price = bSet.LEGOCom.IT.retailPrice;
                                else if (bSet.LEGOCom.US) price = bSet.LEGOCom.US.retailPrice; // Fallback
                            }

                            if (price) {
                                // Tenta atualizar com variante -1, -2, etc. (O mais comum é -1)
                                // Se a DB tiver 75300-1 e a API devolver 75300 e variante 1, bate certo.
                                const setNumVariant = `${bSet.number}-${bSet.numberVariant}`;
                                stmt.run(price, setNumVariant);
                                batchCount++;
                            }
                        });
                        stmt.finalize();
                        db.run("COMMIT", resolve);
                    });
                });
                totalUpdated += batchCount;
            }
        } catch (e) {
            // Ignora erros de rede pontuais para não parar o script
        }

        processedCount += chunk.length;
        const percent = Math.round((processedCount / setsToUpdate.length) * 100);
        process.stdout.write(`\r   ⏳ Progresso: [ ${processedCount} / ${setsToUpdate.length} ] (${percent}%) - Atualizados: ${totalUpdated}`);
        await new Promise(r => setTimeout(r, 1000));
    }
    process.stdout.write("\n");
}

(async () => {
    console.log(`🚀 A INICIAR (Anos ${START_YEAR}-${CURRENT_YEAR})...`);
    for (let y = START_YEAR; y <= CURRENT_YEAR; y++) {
        await syncRebrickable(y); 
        await syncBricksetPricesForYear(y);
    }
    console.log("\n🏁 Terminado.");
})();
