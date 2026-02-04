require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const API_KEY = process.env.REBRICKABLE_API_KEY;
const BASE_URL = 'https://rebrickable.com/api/v3/lego';

// Aumentei o intervalo para garantir que temos dados para mostrar
const YEARS_TO_SYNC = [2024, 2025, 2026, 2027]; 

async function syncThemes() {
    console.log("🎨 A sincronizar TEMAS...");
    let nextUrl = `${BASE_URL}/themes/?page_size=1000`;
    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${API_KEY}` }});
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                const stmt = db.prepare("INSERT OR REPLACE INTO themes (id, name, parent_id) VALUES (?, ?, ?)");
                res.data.results.forEach(t => stmt.run(t.id, t.name, t.parent_id));
                stmt.finalize();
                db.run("COMMIT");
            });
            nextUrl = res.data.next;
        }
        console.log("✅ Temas atualizados.");
    } catch(e) { console.error("❌ Erro Temas:", e.message); }
}

async function syncSets(year) {
    console.log(`\n📡 A sincronizar SETS de ${year}...`);
    let nextUrl = `${BASE_URL}/sets/?min_year=${year}&max_year=${year}&page_size=500`;
    let count = 0;
    try {
        while (nextUrl) {
            const res = await axios.get(nextUrl, { headers: { 'Authorization': `key ${API_KEY}` }});
            await new Promise(r => {
                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");
                    const stmt = db.prepare(`
                        INSERT INTO sets (set_num, name, year, theme_id, num_parts, img_url, eol_status) 
                        VALUES (?, ?, ?, ?, ?, ?, 'Active')
                        ON CONFLICT(set_num) DO UPDATE SET 
                        name=excluded.name, img_url=excluded.img_url, num_parts=excluded.num_parts, theme_id=excluded.theme_id
                    `);
                    res.data.results.forEach(s => {
                        if(s.set_num && s.name) stmt.run(s.set_num, s.name, s.year, s.theme_id, s.num_parts, s.set_img_url);
                    });
                    stmt.finalize();
                    db.run("COMMIT", r);
                });
            });
            count += res.data.results.length;
            nextUrl = res.data.next;
            process.stdout.write(".");
        }
        console.log(`\n✅ ${year}: ${count} sets.`);
    } catch (e) { console.error(`\n❌ Erro ${year}:`, e.message); }
}

(async () => {
    await syncThemes(); // IMPORTANTE: Primeiro temas
    for (let y of YEARS_TO_SYNC) await syncSets(y);
    console.log("🏁 Concluído.");
})();
