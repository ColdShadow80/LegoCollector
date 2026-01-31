require('dotenv').config();
const axios = require('axios');
const db = require('./database');

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

async function syncThemes() {
    console.log('Baixando Temas...');
    try {
        const res = await axios.get(`${BASE_URL}/themes/?page_size=1000`, {
            headers: { 'Authorization': `key ${API_KEY}` }
        });
        
        const stmt = db.prepare("INSERT OR REPLACE INTO themes (id, name, parent_id) VALUES (?, ?, ?)");
        res.data.results.forEach(theme => {
            stmt.run(theme.id, theme.name, theme.parent_id);
        });
        stmt.finalize();
        console.log('Temas atualizados.');
    } catch (error) {
        console.error('Erro temas:', error.message);
    }
}

async function syncSets(year) {
    console.log(`Baixando Sets de ${year}...`);
    try {
        // Busca sets do ano especifico
        const res = await axios.get(`${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=300`, {
            headers: { 'Authorization': `key ${API_KEY}` }
        });

        const stmt = db.prepare(`
            INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, price_eur) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(set_num) DO UPDATE SET 
            name=excluded.name, img_url=excluded.img_url
        `);

        // Nota: Rebrickable nem sempre tem preço em EUR direto na lista, simplifiquei para 0 se nulo
        res.data.results.forEach(set => {
            stmt.run(set.set_num, set.name, set.year, set.theme_id, set.num_parts, set.set_img_url, 0);
        });
        stmt.finalize();
        console.log(`Sets de ${year} processados.`);
        
    } catch (error) {
        console.error('Erro sets:', error.message);
    }
}

// Execução sequencial
(async () => {
    await syncThemes();
    await syncSets(2023); // Pode alterar para loopar vários anos
    await syncSets(2024);
    await syncSets(2025);
    console.log("Sincronização concluída.");
})();
