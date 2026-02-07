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

// --- CONFIGURAÇÃO DE PORTA (DINÂMICA .ENV) ---
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

// Middleware para disponibilizar o utilizador e query em todas as views
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.query = req.query || {};
    next();
});

// --- PASSPORT (AUTENTICAÇÃO V7) ---
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

if (process.env.GOOGLE_CLIENT_ID) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback"
    }, (accessToken, refreshToken, profile, done) => {
        const email = profile.emails[0].value;
        db.get("SELECT * FROM users WHERE google_id = ? OR email = ?", [profile.id, email], (err, user) => {
            if (user) return done(null, user);
            db.run("INSERT INTO users (name, email, google_id, is_verified) VALUES (?, ?, ?, 1)", 
                [profile.displayName, email, profile.id], function() {
                done(null, { id: this.lastID, name: profile.displayName, email });
            });
        });
    }));
}

// --- ROTAS DO CATÁLOGO (CORREÇÃO DE TEMAS DUPLICADOS) ---
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

    let orderBy = "sets.name ASC";
    if (sort === 'year_desc') orderBy = "sets.year DESC";
    else if (sort === 'parts_desc') orderBy = "sets.num_parts DESC";

    const sql = `SELECT sets.*, themes.name as theme_name, user_sets.status as user_status 
                 FROM sets JOIN themes ON sets.theme_id = themes.id 
                 LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ?
                 ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    // SELECT DISTINCT para remover duplicados na Sidebar
    db.all("SELECT DISTINCT name FROM themes WHERE is_hidden = 0 ORDER BY name ASC", [], (e1, allThemes) => {
        db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => {
            db.all(sql, [...params, limit, offset], (err, sets) => {
                db.get(`SELECT COUNT(*) as total FROM sets JOIN themes ON sets.theme_id = themes.id ${where.replace('user_sets.status', '1')}`, params.slice(0,-2), (e3, count) => {
                    res.render('index', { 
                        sets: sets || [], 
                        allThemes: allThemes || [], 
                        allYears: allYears || [], 
                        pagination: { page, totalPages: Math.ceil((count?.total || 0) / limit), totalItems: count?.total || 0 }
                    });
                });
            });
        });
    });
});

// --- ROTAS DE GESTÃO E ADMIN (CORREÇÃO CANNOT GET) ---
app.get('/set/:set_num', (req, res) => {
    db.get(`SELECT sets.*, themes.name as theme_name, user_sets.status as user_status, user_sets.location, user_sets.build_status FROM sets JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? WHERE sets.set_num = ?`, [req.user ? req.user.id : 0, req.params.set_num], (err, set) => {
        if (!set) return res.redirect('/');
        set.rb_url = `https://rebrickable.com/sets/${set.set_num}`;
        res.render('set_detail', { set });
    });
});

app.get('/admin/sets', (req, res) => { if (req.user?.id === 1) res.render('admin/sets'); else res.redirect('/'); });
app.get('/admin/themes', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all(`SELECT t.*, COUNT(s.set_num) as total_sets, COALESCE(SUM(s.num_parts), 0) as total_parts 
            FROM themes t LEFT JOIN sets s ON t.id = s.theme_id GROUP BY t.id ORDER BY t.name ASC`, [], (err, themes) => {
        res.render('admin/themes', { themes });
    });
});
app.get('/admin/users', (req, res) => { if (req.user?.id === 1) db.all("SELECT * FROM users", [], (err, users) => res.render('admin/users', { users, sort: 'id' })); else res.redirect('/'); });

app.get('/import', (req, res) => { if (req.user) res.render('import'); else res.redirect('/login'); });
app.get('/manual', (req, res) => res.render('manual'));

// --- API SCANNER V11.2 (COM APRENDIZAGEM) ---
app.get('/api/scan', async (req, res) => {
    const { code } = req.query;
    db.get("SELECT s.* FROM sets s JOIN barcodes b ON s.set_num = b.set_num WHERE b.code = ?", [code], (err, row) => {
        if (row) return res.json({ found: true, set: row });
        res.json({ found: false });
    });
});

app.post('/api/scan/associate', (req, res) => {
    if (!req.user) return res.status(401).send();
    db.run("INSERT OR REPLACE INTO barcodes (code, set_num) VALUES (?, ?)", [req.body.barcode, req.body.set_num], () => res.json({success: true}));
});

app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { set_num, status } = req.body;
    db.run("INSERT INTO user_sets (user_id, set_num, status) VALUES (?, ?, ?) ON CONFLICT(user_id, set_num) DO UPDATE SET status = excluded.status", [req.user.id, set_num, status], () => res.json({ok: true}));
});

// --- AUTENTICAÇÃO ---
app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login' }));
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [req.body.name, req.body.email, hash], (err) => {
        if (err) return res.redirect('/login?error=email_exists');
        res.redirect('/login?success=registered');
    });
});
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { successRedirect: '/', failureRedirect: '/login' }));

app.listen(PORT, () => console.log(`🚀 LegoTracker V11.2 activo na porta ${PORT}`));
