const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db'); // Importa o db.js configurado anteriormente
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'lego-secret-key',
    resave: false,
    saveUninitialized: false
}));

// Middleware para disponibilizar o utilizador em todas as views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// --- ROTAS DE NAVEGAÇÃO ---

app.get('/', (req, res) => {
    const { search, year, themes, sort, status } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = res.locals.user ? res.locals.user.items_per_page || 25 : 25;
    const offset = (page - 1) * limit;

    let queryStr = `SELECT s.*, us.status as user_status 
                    FROM sets s 
                    LEFT JOIN user_sets us ON s.set_num = us.set_num 
                    AND us.user_id = ? WHERE 1=1`;
    let params = [res.locals.user ? res.locals.user.id : 0];

    if (search) { queryStr += ` AND (s.name LIKE ? OR s.set_num LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    if (year) { queryStr += ` AND s.year = ?`; params.push(year); }
    if (themes) {
        const themeList = Array.isArray(themes) ? themes : [themes];
        queryStr += ` AND s.theme_id IN (SELECT id FROM themes WHERE name IN (${themeList.map(() => '?').join(',')}))`;
        params.push(...themeList);
    }
    if (status === 'owned') queryStr += ` AND us.status = 'OWNED'`;
    if (status === 'wanted') queryStr += ` AND us.status = 'WANTED'`;

    if (sort === 'year_desc') queryStr += ` ORDER BY s.year DESC`;
    else if (sort === 'parts_desc') queryStr += ` ORDER BY s.num_parts DESC`;
    else queryStr += ` ORDER BY s.name ASC`;

    queryStr += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    // Query para Temas Únicos (Resolve o erro de duplicados)
    db.all("SELECT DISTINCT name FROM themes ORDER BY name ASC", [], (err, allThemes) => {
        db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (err, allYears) => {
            db.all(queryStr, params, (err, sets) => {
                db.get("SELECT COUNT(*) as total FROM sets", (err, count) => {
                    res.render('index', {
                        sets: sets || [],
                        allThemes: allThemes || [],
                        allYears: allYears || [],
                        query: req.query,
                        pagination: {
                            page,
                            totalPages: Math.ceil((count ? count.total : 0) / limit),
                            totalItems: count ? count.total : 0
                        }
                    });
                });
            });
        });
    });
});

// --- ROTAS EM FALTA (CORREÇÃO "Cannot GET") ---

app.get('/admin/sets', (req, res) => {
    if (!req.session.user || req.session.user.id !== 1) return res.redirect('/');
    res.render('admin_sets'); // Certifique-se que este .ejs existe
});

app.get('/import', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('import_export');
});

app.get('/manual', (req, res) => {
    res.render('manual_instrucoes');
});

// --- API E SCANNER ---

app.get('/api/scan', (req, res) => {
    const code = req.query.code;
    db.get("SELECT s.* FROM sets s JOIN barcodes b ON s.set_num = b.set_num WHERE b.code = ?", [code], (err, row) => {
        if (row) res.json({ found: true, set: row });
        else res.json({ found: false });
    });
});

app.post('/api/toggle', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Login necessário' });
    const { set_num, status } = req.body;
    db.run(`INSERT INTO user_sets (user_id, set_num, status) VALUES (?, ?, ?)
            ON CONFLICT(user_id, set_num) DO UPDATE SET status = ?`,
            [req.session.user.id, set_num, status, status], (err) => {
        res.json({ success: true });
    });
});

// --- AUTENTICAÇÃO E REGISTO ---

app.get('/login', (req, res) => res.render('login'));

app.get('/register', (req, res) => res.render('register')); // Rota de registo manual

app.post('/register', (req, res) => {
    const { name, email, password } = req.body;
    db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, password], (err) => {
        if (err) return res.send("Erro ao registar utilizador.");
        res.redirect('/login');
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ? AND password = ?", [email, password], (err, user) => {
        if (user) {
            req.session.user = user;
            res.redirect('/');
        } else {
            res.send("Credenciais inválidas.");
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(3000, () => console.log("🚀 LegoTracker V11 a correr em http://localhost:3000"));
