require('dotenv').config();
const axios = require('axios');
const db = require('./db');

// Certifique-se que no .env tem: BRICKSET_API_KEY=sua_chave
const BRICKSET_KEY = process.env.BRICKSET_API_KEY;

if (!BRICKSET_KEY) {
    console.error("❌ Erro: BRICKSET_API_KEY não definida no ficheiro .env");
    process.exit(1);
}

// 1. Buscar sets sem preço na nossa BD
function getSetsWithoutPrice() {
    return new Promise((resolve, reject) => {
        // Seleciona sets onde o preço é NULL ou 0
        const sql = "SELECT set_num FROM sets WHERE price_eur IS NULL OR price_eur = 0";
        db.all(sql, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// 2. Chamar a API do Brickset (URL CORRIGIDO)
async function fetchBricksetPrice(setNumsChunk) {
    // A API pede os sets separados por vírgula
    const query = setNumsChunk.join(',');
    
    // CORREÇÃO AQUI: Removido "api." do início do URL
    // O formato do parametro params deve ser um JSON string
    const params = JSON.stringify({ setNumber: query });
    const url = `https://brickset.com/api/v3.asmx/getSets?apiKey=${BRICKSET_KEY}&userHash=&params=${encodeURIComponent(params)}`;

    try {
        const response = await axios.get(url);
        if (response.data && response.data.sets) {
            return response.data.sets;
        }
        return [];
    } catch (error) {
        console.error("⚠️ Erro no Brickset:", error.message);
        return [];
    }
}

// 3. Atualizar a base de dados
async function updatePrice(setNum, price) {
    return new Promise((resolve) => {
        if (!price) { resolve(); return; }
        
        const sql = "UPDATE sets SET price_eur = ? WHERE set_num = ?";
        db.run(sql, [price, setNum], (err) => {
            if (err) console.error(`❌ Erro ao atualizar ${setNum}:`, err.message);
            resolve();
        });
    });
}

// --- FLUXO PRINCIPAL ---
(async () => {
    console.log("💰 A iniciar sincronização de preços (Brickset)...");
    
    try {
        const setsToUpdate = await getSetsWithoutPrice();
        console.log(`📋 Encontrados ${setsToUpdate.length} sets sem preço.`);

        if (setsToUpdate.length === 0) {
            console.log("🏁 Tudo atualizado.");
            return;
        }

        // Lotes de 20 para ser rápido mas seguro
        const CHUNK_SIZE = 20;
        
        for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
            const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE).map(s => s.set_num);
            
            process.stdout.write(`📡 Lote ${(i/CHUNK_SIZE) + 1}: `);
            const bricksetData = await fetchBricksetPrice(chunk);

            let updatedCount = 0;

            for (const bSet of bricksetData) {
                let price = null;
                
                // Tenta obter o preço da Alemanha (DE), que é a melhor referência Euro
                if (bSet.LEGOCom && bSet.LEGOCom.DE && bSet.LEGOCom.DE.retailPrice) {
                    price = bSet.LEGOCom.DE.retailPrice;
                } 
                // Fallback: Se não tiver DE, tenta US e converte (opcional, aqui apenas ignoramos)
                
                if (price) {
                    // O Brickset devolve setID (ex: 75300) e variant (ex: 1).
                    // Temos de juntar para bater certo com o Rebrickable (75300-1)
                    await updatePrice(`${bSet.number}-${bSet.numberVariant}`, price);
                    updatedCount++;
                }
            }
            console.log(`${updatedCount} preços encontrados.`);
            
            // Pausa de 1 segundo entre pedidos
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log("\n✅ Sincronização de preços concluída!");

    } catch (e) {
        console.error("\n❌ Erro fatal:", e);
    }
})();
