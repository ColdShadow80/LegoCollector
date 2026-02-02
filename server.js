require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const db = require('./db');
const app = express();

// --- 1. CONFIGURAÇÃO PASSPORT ---
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user || !user.password) return done(null, false);
        try {
            if (await bcrypt.compare(password, user.password)) return done(null, user);
        } catch(e) { return done(e); }
        return done(null, false);
    });
}));

if (process.env.GOOGLE_CLIENT_ID) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback"
    }, (accessToken, refreshToken, profile, done) => {
        const email = profile.emails[0].value;
        const googleId = profile.id;
        db.get("SELECT * FROM users WHERE google_id = ? OR email = ?", [googleId, email], (err, user) => {
            if (user) return done(null, user);
            db.run("INSERT INTO users (name, email, google_id) VALUES (?, ?, ?)", 
                [profile.displayName, email, googleId], function(err) {
                if(this.lastID === 1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                done(null, { id: this.lastID, name: profile.displayName, email });
            });
        });
    }));
}

// --- 2. MIDDLEWARES ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: process.env.SESSION_SECRET || 'segredo_lego',
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- 3. ROTA PRINCIPAL (COM PAGINAÇÃO E FILTROS) ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : null;
    let { themes, year, search, page, limit } = req.query;

    // Definição de Limites
    let limitVal = limit || (req.user ? req.user.items_per_page : 25);
    if (limitVal === 'all') limitVal = 10000;
    let pageVal = parseInt(page) || 1;
    let offset = (pageVal - 1) * limitVal;

    // Construção da Query de Filtros
    let sqlParams = [];
    let whereClause = "WHERE 1=1";

    if (themes) {
        const themeList = Array.isArray(themes) ? themes : [themes];
        const placeholders = themeList.map(() => '?').join(',');
        whereClause += ` AND themes.name IN (${placeholders})`;
        sqlParams.push(...themeList);
    }

    if (year) { whereClause += " AND sets.year = ?"; sqlParams.push(year); }
    if (search) { whereClause += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; sqlParams.push(`%${search}%`, `%${search}%`); }

    // Lógica Visitante vs Coleção
    if (req.user && !themes && !year && !search) {
        whereClause += " AND user_sets.user_id = ?";
        sqlParams.push(userId);
    } else if (!req.user && !themes && !year && !search) {
        whereClause += " AND sets.year = ?";
        sqlParams.push(new Date().getFullYear());
    }

    // Query 1: Contagem Total (para paginação)
    let countSql = `
        SELECT COUNT(*) as total 
        FROM sets 
        LEFT JOIN themes ON sets.theme_id = themes.id 
        LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? 
        ${whereClause}
    `;
    
    db.get(countSql, [userId, ...sqlParams], (err, row) => {
        if(err) console.error(err);
        const totalItems = row ? row.total : 0;
        const totalPages = Math.ceil(totalItems / limitVal);

        // Query 2: Dados Reais dos Sets
        let dataSql = `
            SELECT sets.*, themes.name as theme_name, 
            CASE WHEN user_sets.user_id IS NOT NULL THEN 1 ELSE 0 END as is_owned
            FROM sets 
            LEFT JOIN themes ON sets.theme_id = themes.id 
            LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? 
            ${whereClause}
            ORDER BY themes.name ASC, sets.year DESC 
            LIMIT ? OFFSET ?
        `;

        db.all(dataSql, [userId, ...sqlParams, limitVal, offset], (err, sets) => {
            
            // Query 3: Lista de Temas COM Intervalo de Anos
            // Nota: JOIN com sets para calcular MIN/MAX year. 
            // Mostra apenas temas que têm sets na base de dados.
            let themesSql = `
                SELECT themes.name, MIN(sets.year) as min_year, MAX(sets.year) as max_year
                FROM themes
                JOIN sets ON themes.id = sets.theme_id
                GROUP BY themes.id
                ORDER BY themes.name ASC
            `;

            db.all(themesSql, [], (e1, allThemes) => {
                db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => {
                    res.render('index', { 
                        sets: sets || [], 
                        allThemes: allThemes || [], 
                        allYears: allYears || [], 
                        query: req.query, 
                        pagination: { page: pageVal, limit: limit || (req.user?.items_per_page || 25), totalPages, totalItems },
                        user: req.user,
                        currentYear: new Date().getFullYear()
                    });
                });
            });
        });
    });
});

// API Preferências
app.post('/api/preferences', (req, res) => {
    if (!req.user) return res.status(401).json({error: "Login necessário"});
    const { dark_mode, items_per_page } = req.body;
    let sql = "UPDATE users SET ";
    let params = [];
    let updates = [];

    if (dark_mode !== undefined) { updates.push("dark_mode = ?"); params.push(dark_mode ? 1 : 0); }
    if (items_per_page !== undefined) { updates.push("items_per_page = ?"); params.push(items_per_page); }

    if (updates.length > 0) {
        sql += updates.join(", ") + " WHERE id = ?";
        params.push(req.user.id);
        db.run(sql, params, (err) => {
            if (err) return res.status(500).json({error: err.message});
            res.json({success: true});
        });
    } else { res.json({ok: true}); }
});

// Rotas Auth
app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login?error=1' }));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });
app.post('/register', async (req, res) => {
    try {
        const hashed = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", 
            [req.body.name, req.body.email, hashed], 
            function(err) {
                if(this.lastID === 1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                res.redirect('/login');
            });
    } catch (e) { res.redirect('/login'); }
});

// API Toggle Sets
app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    const query = req.body.active 
        ? "INSERT OR IGNORE INTO user_sets (user_id, set_num) VALUES (?, ?)"
        : "DELETE FROM user_sets WHERE user_id = ? AND set_num = ?";
    db.run(query, [req.user.id, req.body.set_num], () => res.json({ok: true}));
});

// Auth Google
app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.send("Google Auth não configurado.");
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
