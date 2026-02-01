const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const csv = require('csv-parser');
const db = require('./database');

// URLs oficiais dos dumps diários do Rebrickable
const URL_THEMES = 'https://cdn.rebrickable.com/media/downloads/themes.csv.gz';
const URL_SETS = 'https://cdn.rebrickable.com/media/downloads/sets.csv.gz';

// Função auxiliar para baixar, descompactar e inserir dados
async function processarArquivo(url, queryInsert, mapRow) {
    console.log(`Iniciando download e processamento de: ${url}`);
    
    return new Promise(async (resolve, reject) => {
        try {
            // Inicia o download via Stream
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream'
            });

            // Inicia Transação no Banco (Performance CRÍTICA para SQLite)
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                
                const stmt = db.prepare(queryInsert);
                let contador = 0;

                // Pipeline: Download -> Descompactar (Gunzip) -> Ler CSV -> Inserir
                response.data
                    .pipe(zlib.createGunzip())
                    .pipe(csv())
                    .on('data', (row) => {
                        // Mapeia os dados do CSV para o formato da Query
                        const values = mapRow(row);
                        stmt.run(values);
                        contador++;
                        if (contador % 5000 === 0) process.stdout.write(`.`); // Barra de progresso visual
                    })
                    .on('end', () => {
                        stmt.finalize();
                        db.run("COMMIT", () => {
                            console.log(`\nConcluído! ${contador} registros inseridos.`);
                            resolve();
                        });
                    })
                    .on('error', (err) => {
                        db.run("ROLLBACK");
                        reject(err);
                    });
            });

        } catch (error) {
            reject(error);
        }
    });
}

async function main() {
    console.log("--- INICIANDO IMPORTAÇÃO MASSIVA ---");

    try {
        // 1. Importar TEMA (Themes) primeiro
        // CSV Headers: id, name, parent_id
        await processarArquivo(
            URL_THEMES,
            "INSERT OR REPLACE INTO themes (id, name, parent_id) VALUES (?, ?, ?)",
            (row) => [row.id, row.name, row.parent_id || null]
        );

        // 2. Importar SETS
        // CSV Headers: set_num, name, year, theme_id, num_parts, img_url
        await processarArquivo(
            URL_SETS,
            "INSERT OR REPLACE INTO sets (set_num, name, year, theme_id, num_parts, img_url, price_eur) VALUES (?, ?, ?, ?, ?, ?, 0)",
            (row) => [row.set_num, row.name, row.year, row.theme_id, row.num_parts, row.img_url]
        );

        console.log("--- IMPORTAÇÃO FINALIZADA COM SUCESSO ---");
        console.log("Agora você pode rodar 'npm start' para ver o site.");

    } catch (error) {
        console.error("Erro fatal na importação:", error);
    }
}

main();
