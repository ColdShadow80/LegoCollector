require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./db');
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

// Middleware Global
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.query = req.query || {};
    next();
});

// Passport Strategy
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return done(null, false);
        const match = await bcrypt.compare(password, user.password);
        if (match) return done(null, user);
        return done(null, false);
    });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

// --- ROTA CATALOGO PRINCIPAL ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : 0;
    const { search, year, themes, status } = req.query;
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
                db.get(`SELECT COUNT(*) as total FROM sets JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${where}`, [userId, ...params.slice(1)], (e3, count) => {
                    res.render('index', { 
                        sets: sets || [], allThemes: allThemes || [], allYears: allYears || [], 
                        pagination: { page, totalPages: Math.ceil((count?.total || 0) / limit), totalItems: count?.total || 0 }
                    });
                });
            });
        });
    });
});

// --- DASHBOARD (FIXED) ---
app.get('/dashboard', (req, res) => {
    if (!req.user) return res.redirect('/login');
    const u = req.user.id;
    const q1 = new Promise(r => db.get(`SELECT COUNT(*) as total_items, SUM(sets.num_parts) as total_parts, SUM(sets.price_eur) as total_value_rrp FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'OWNED'`, [u], (e, row) => r(row || {})));
    const q2 = new Promise(r => db.get(`SELECT COUNT(*) as wanted_count, SUM(sets.price_eur) as wanted_value FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'WANTED'`, [u], (e, row) => r(row || {})));
    const q3 = new Promise(r => db.all(`SELECT themes.name, COUNT(*) as count FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num JOIN themes ON sets.theme_id = themes.id WHERE user_id = ? AND status = 'OWNED' GROUP BY themes.name ORDER BY count DESC LIMIT 5`, [u], (e, rows) => r(rows || [])));
    const q4 = new Promise(r => db.all(`SELECT sets.year, COUNT(*) as count FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'OWNED' GROUP BY sets.year ORDER BY sets.year ASC`, [u], (e, rows) => r(rows || [])));

    Promise.all([q1, q2, q3, q4]).then(([stats, wishlist, themes, years]) => {
        res.render('dashboard', { stats, wishlist, themes, years });
    });
});

// --- ADMIN ---
app.get('/admin/sets', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all("SELECT sets.*, themes.name as theme_name FROM sets JOIN themes ON sets.theme_id = themes.id LIMIT 100", [], (err, sets) => {
        res.render('admin/sets', { sets: sets || [], pagination: { page: 1, totalPages: 1 } });
    });
});

app.get('/admin/themes', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all(`SELECT t.*, COUNT(s.set_num) as total_sets, COALESCE(SUM(s.num_parts), 0) as total_parts 
            FROM themes t LEFT JOIN sets s ON t.id = s.theme_id GROUP BY t.id ORDER BY t.name ASC`, [], (err, themes) => {
        res.render('admin/themes', { themes: themes || [] });
    });
});

app.get('/admin/users', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all("SELECT * FROM users", [], (err, users) => res.render('admin/users', { users: users || [], sort: 'id' }));
});

// --- UTILITÁRIOS ---
app.get('/import', (req, res) => req.user ? res.render('import') : res.redirect('/login'));
app.get('/manual', (req, res) => res.render('manual'));
app.get('/logout', (req, res, next) => req.logout((err) => res.redirect('/')));

app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    db.run("INSERT INTO user_sets (user_id, set_num, status) VALUES (?, ?, ?) ON CONFLICT(user_id, set_num) DO UPDATE SET status = excluded.status", [req.user.id, req.body.set_num, req.body.status], () => res.json({ok: true}));
});

app.get('/login', (req, res) => res.render('login'));
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [req.body.name, req.body.email, hash], () => res.redirect('/login'));
});
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login' }));

app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
