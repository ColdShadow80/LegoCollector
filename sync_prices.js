require('dotenv').config();
const axios = require('axios');
const db = require('./db');

// Adiciona isto ao teu .env: BRICKSET_API_KEY=tua_chave_aqui
const BRICKSET_KEY = process.env.BRICKSET_API_KEY;

if (!BRICKSET_KEY) {
    console.error("❌ Erro: BRICKSET_API_KEY não definida no ficheiro .env");
    process.exit(1);
}

// Função para obter Sets sem preço da nossa BD
function getSetsWithoutPrice() {
    return new Promise((resolve, reject) => {
        // Vamos buscar sets que tenham preço 0 ou NULL
        const sql = "SELECT set_num FROM sets WHERE price_eur IS NULL OR price_eur = 0";
        db.all(sql, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Função para chamar a API do Brickset
async function fetchBricksetPrice(setNumsChunk) {
    // A API do Brickset aceita sets separados por vírgula (ex: "75346-1,75300-1")
    // O Brickset usa o formato {número}-{variante}. O Rebrickable já usa este formato.
    
    const query = setNumsChunk.join(',');
    const url = `https://api.brickset.com/api/v3.asmx/getSets?apiKey=${BRICKSET_KEY}&userHash=&params={'setNumber':'${query}'}`;

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

async function updatePrice(setNum, price) {
    return new Promise((resolve) => {
        if (!price) { resolve(); return; }
        
        const sql = "UPDATE sets SET price_eur = ? WHERE set_num = ?";
        db.run(sql, [price, setNum], (err) => {
            if (err) console.error(`❌ Erro ao atualizar ${setNum}:`, err.message);
            // else console.log(`✅ ${setNum} atualizado para €${price}`);
            resolve();
        });
    });
}

(async () => {
    console.log("💰 A iniciar sincronização de preços (Brickset)...");
    
    try {
        const setsToUpdate = await getSetsWithoutPrice();
        console.log(`📋 Encontrados ${setsToUpdate.length} sets sem preço.`);

        if (setsToUpdate.length === 0) {
            console.log("🏁 Tudo atualizado.");
            return;
        }

        // O Brickset permite pedir vários sets de uma vez. Vamos fazer em lotes de 20 para ser rápido.
        const CHUNK_SIZE = 20;
        
        for (let i = 0; i < setsToUpdate.length; i += CHUNK_SIZE) {
            const chunk = setsToUpdate.slice(i, i + CHUNK_SIZE).map(s => s.set_num);
            
            console.log(`📡 A pedir preços para lote ${i/CHUNK_SIZE + 1}...`);
            const bricksetData = await fetchBricksetPrice(chunk);

            for (const bSet of bricksetData) {
                // Tenta apanhar o preço em EUR, se não tiver, tenta USD (opcional)
                let price = null;
                
                // Estrutura do Brickset: retailPrice.EU ou retailPrice.DE etc.
                if (bSet.LEGOCom && bSet.LEGOCom.DE && bSet.LEGOCom.DE.retailPrice) {
                    price = bSet.LEGOCom.DE.retailPrice;
                } else if (bSet.LEGOCom && bSet.LEGOCom.US && bSet.LEGOCom.US.retailPrice) {
                    // Conversão aproximada ou guarda em USD? Vamos assumir 1:1 para simplificar ou ignorar
                    // price = bSet.LEGOCom.US.retailPrice; 
                }

                if (price) {
                    // O set_num no Brickset vem como "75346-1". Deve bater certo com o nosso.
                    await updatePrice(bSet.number + '-' + bSet.numberVariant, price);
                    process.stdout.write("€");
                } else {
                    process.stdout.write(".");
                }
            }
            // Pequena pausa para não ser banido
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log("\n✅ Sincronização de preços concluída!");

    } catch (e) {
        console.error("\n❌ Erro fatal:", e);
    }
})();
