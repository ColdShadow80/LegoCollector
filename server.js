require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./db');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: process.env.SESSION_SECRET || 'lego_tracker_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 3600000 }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.query = req.query || {};
    next();
});

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page, google_id FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return done(null, false, { message: 'Credenciais inválidas.' });
        if (!user.password) return done(null, false, { message: 'Inicie sessão com o Google.' });
        if (await bcrypt.compare(password, user.password)) return done(null, user);
        return done(null, false, { message: 'Credenciais inválidas.' });
    });
}));

// --- ROTA CATALOGO PRINCIPAL ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : 0;
    const { search, year, themes, sort, status } = req.query;
    const limit = req.user ? req.user.items_per_page || 25 : 25;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    let where = "WHERE (themes.is_hidden IS NULL OR themes.is_hidden = 0)";
    let params = [userId];

    if (search) { where += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
    if (year) { where += " AND sets.year = ?"; params.push(year); }
    if (themes) {
        const list = Array.isArray(themes) ? themes : [themes];
        where += ` AND themes.name IN (${list.map(() => '?').join(',')})`;
        params.push(...list);
    }
    if (status === 'owned') where += " AND user_sets.status = 'OWNED'";
    if (status === 'wanted') where += " AND user_sets.status = 'WANTED'";

    const sql = `SELECT sets.*, themes.name as theme_name, user_sets.status as user_status 
                 FROM sets JOIN themes ON sets.theme_id = themes.id 
                 LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ?
                 ${where} ORDER BY sets.name ASC LIMIT ? OFFSET ?`;

    db.all("SELECT DISTINCT name FROM themes WHERE is_hidden = 0 ORDER BY name ASC", [], (e1, allThemes) => {
        db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => {
            db.all(sql, [...params, limit, offset], (err, sets) => {
                db.get(`SELECT COUNT(*) as total FROM sets JOIN themes ON sets.theme_id = themes.id ${where.replace('user_sets.status', '1')}`, params.slice(0,-2), (e3, count) => {
                    res.render('index', { 
                        sets: sets || [], allThemes: allThemes || [], allYears: allYears || [], 
                        pagination: { page, totalPages: Math.ceil((count?.total || 0) / limit), totalItems: count?.total || 0 }
                    });
                });
            });
        });
    });
});

// --- ROTA ADMIN SETS (CORRIGIDA) ---
app.get('/admin/sets', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    db.all("SELECT sets.*, themes.name as theme_name FROM sets JOIN themes ON sets.theme_id = themes.id ORDER BY sets.year DESC LIMIT ? OFFSET ?", [limit, offset], (err, sets) => {
        db.get("SELECT COUNT(*) as total FROM sets", [], (err, count) => {
            res.render('admin/sets', { 
                sets: sets || [], 
                pagination: { page, totalPages: Math.ceil((count?.total || 0) / limit), totalItems: count?.total || 0 }
            });
        });
    });
});

// --- RESTANTES ROTAS DE GESTÃO ---
app.get('/admin/themes', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    const sql = `SELECT t.*, COUNT(s.set_num) as total_sets, COALESCE(SUM(s.num_parts), 0) as total_parts 
                 FROM themes t LEFT JOIN sets s ON t.id = s.theme_id GROUP BY t.id ORDER BY t.name ASC`;
    db.all(sql, [], (err, themes) => res.render('admin/themes', { themes: themes || [] }));
});

app.get('/admin/users', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all("SELECT * FROM users ORDER BY id ASC", [], (err, users) => res.render('admin/users', { users: users || [], sort: 'id' }));
});

app.get('/import', (req, res) => { if (req.user) res.render('import'); else res.redirect('/login'); });
app.get('/manual', (req, res) => res.render('manual'));

app.listen(PORT, () => console.log(`🚀 LegoTracker V11.2 activo na porta ${PORT}`));
