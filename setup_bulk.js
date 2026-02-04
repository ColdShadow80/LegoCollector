const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const csv = require('csv-parser');
// CORREÇÃO: Aponta para './db' em vez de './database'
const db = require('./db'); 

// URLs oficiais dos dumps diários do Rebrickable
const URL_THEMES = 'https://cdn.rebrickable.com/media/downloads/themes.csv.gz';
const URL_SETS = 'https://cdn.rebrickable.com/media/downloads/sets.csv.gz';

// Função auxiliar para baixar, descompactar e inserir dados
async function processarArquivo(url, queryInsert, mapRow) {
    console.log(`Iniciando download e processamento de: ${url}`);
    
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream'
            });

            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                
                const stmt = db.prepare(queryInsert);
                let contador = 0;

                response.data
                    .pipe(zlib.createGunzip())
                    .pipe(csv())
                    .on('data', (row) => {
                        try {
                            const values = mapRow(row);
                            stmt.run(values);
                            contador++;
                            if (contador % 5000 === 0) process.stdout.write(`.`);
                        } catch (e) {
                            // Ignora erros de linhas mal formatadas
                        }
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

    // Pequeno delay para garantir que as migrações do db.js correram (criação de tabelas)
    await new Promise(r => setTimeout(r, 1000));

    try {
        // 1. Importar TEMA (Themes)
        await processarArquivo(
            URL_THEMES,
            "INSERT OR REPLACE INTO themes (id, name, parent_id) VALUES (?, ?, ?)",
            (row) => [row.id, row.name, row.parent_id || null]
        );

        // 2. Importar SETS
        // Importante: Mapeamos para a estrutura atual da tabela sets
        await processarArquivo(
            URL_SETS,
            `INSERT OR REPLACE INTO sets 
            (set_num, name, year, theme_id, num_parts, img_url, eol_status, price_eur) 
            VALUES (?, ?, ?, ?, ?, ?, 'Active', 0)`,
            (row) => [row.set_num, row.name, row.year, row.theme_id, row.num_parts, row.img_url]
        );

        console.log("--- IMPORTAÇÃO FINALIZADA COM SUCESSO ---");

    } catch (error) {
        console.error("Erro fatal na importação:", error);
    }
}

main();
