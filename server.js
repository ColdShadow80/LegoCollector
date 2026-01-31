require('dotenv').config();
const express = require('express');
const db = require('./database');
const cron = require('node-cron');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

// Rota Principal (Listagem e Filtros)
app.get('/', (req, res) => {
    let { theme, year, sort, search, status } = req.query;
    
    let sql = `SELECT sets.*, themes.name as theme_name 
               FROM sets LEFT JOIN themes ON sets.theme_id = themes.id 
               WHERE 1=1`;
    let params = [];

    if (theme) { sql += " AND themes.name LIKE ?"; params.push(`%${theme}%`); }
    if (year) { sql += " AND year = ?"; params.push(year); }
    if (search) { sql += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
    
    // Filtros especiais
    if (status === 'retired') { sql += " AND eol_status = 'Retired'"; }
    if (status === 'owned') { sql += " AND owned = 1"; }

    // Ordenação
    if (sort === 'year_desc') { sql += " ORDER BY year DESC"; }
    else if (sort === 'parts_desc') { sql += " ORDER BY num_parts DESC"; }
    else { sql += " ORDER BY year DESC, name ASC"; } // Default

    db.all(sql, params, (err, sets) => {
        db.all("SELECT DISTINCT name FROM themes ORDER BY name", [], (err, themes) => {
            db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (err, years) => {
                res.render('index', { sets, themes, years, query: req.query });
            });
        });
    });
});

// API para Marcar como "Tenho"
app.post('/api/toggle-owned', (req, res) => {
    const { set_num, owned } = req.body;
    db.run("UPDATE sets SET owned = ? WHERE set_num = ?", [owned ? 1 : 0, set_num], (err) => {
        if (err) res.status(500).json({error: err.message});
        else res.json({success: true});
    });
});

// Cron Job: Todos os dias às 04:00 da manhã, dado que a carga é muito leve (apenas sets novos)
cron.schedule('0 4 * * *', () => {
    console.log("Iniciando verificação diária de novos sets...");
    const { exec } = require('child_process');
    exec('node sync.js', (error, stdout, stderr) => {
        if (error) console.error(`Erro no cron: ${error}`);
        if (stdout) console.log(stdout);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
