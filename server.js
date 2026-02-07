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

app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.query = req.query || {};
    res.locals.success = req.query.success || null;
    res.locals.error = req.query.error || null;
    next();
});

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return done(null, false);
        if (await bcrypt.compare(password, user.password)) return done(null, user);
        return done(null, false);
    });
}));

// --- CATALOGO (CORREÇÃO DE CONTAGEM E DUPLICADOS) ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : 0;
    const { search, year, themes, sort, status } = req.query;
    const limit = req.user ? req.user.items_per_page || 25 : 25;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";
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
                 FROM sets 
                 JOIN themes ON sets.theme_id = themes.id 
                 LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ?
                 ${where} ORDER BY sets.name ASC LIMIT ? OFFSET ?`;

    db.all("SELECT DISTINCT name FROM themes ORDER BY name ASC", [], (e1, allThemes) => {
        db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => {
            db.all(sql, [...params, limit, offset], (err, sets) => {
                // Contagem total para paginação (Corrigida para não usar limit/offset)
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

app.get('/dashboard', (req, res) => {
    if (!req.user) return res.redirect('/login');
    db.get("SELECT COUNT(*) as total, SUM(sets.num_parts) as parts FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'OWNED'", [req.user.id], (err, stats) => {
        res.render('dashboard', { stats: stats || { total: 0, parts: 0 } });
    });
});

app.get('/set/:set_num', (req, res) => {
    db.get(`SELECT sets.*, themes.name as theme_name, user_sets.status as user_status, user_sets.location, user_sets.build_status FROM sets JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? WHERE sets.set_num = ?`, [req.user ? req.user.id : 0, req.params.set_num], (err, set) => {
        if (!set) return res.redirect('/');
        res.render('set_detail', { set });
    });
});

app.get('/admin/sets', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all("SELECT sets.*, themes.name as theme_name FROM sets JOIN themes ON sets.theme_id = themes.id LIMIT 100", [], (err, sets) => {
        res.render('admin/sets', { sets: sets || [] });
    });
});

app.get('/admin/themes', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all("SELECT t.*, COUNT(s.set_num) as total_sets, COALESCE(SUM(s.num_parts), 0) as total_parts FROM themes t LEFT JOIN sets s ON t.id = s.theme_id GROUP BY t.id", [], (err, themes) => {
        res.render('admin/themes', { themes: themes || [] });
    });
});

app.get('/admin/users', (req, res) => {
    if (req.user?.id !== 1) return res.redirect('/');
    db.all("SELECT * FROM users", [], (err, users) => res.render('admin/users', { users: users || [] }));
});

app.get('/import', (req, res) => { if (req.user) res.render('import'); else res.redirect('/login'); });
app.get('/manual', (req, res) => res.render('manual'));
app.get('/scan', (req, res) => { if (req.user) res.render('scan'); else res.redirect('/login'); });

app.get('/logout', (req, res, next) => {
    req.logout((err) => { if (err) return next(err); res.redirect('/'); });
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login?error=1' }));
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [req.body.name, req.body.email, hash], () => res.redirect('/login'));
});

// API Toggle Status
app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).json({error: 'Auth'});
    const { set_num, status } = req.body;
    db.run("INSERT INTO user_sets (user_id, set_num, status) VALUES (?, ?, ?) ON CONFLICT(user_id, set_num) DO UPDATE SET status = excluded.status", [req.user.id, set_num, status], () => res.json({ok: true}));
});

app.listen(PORT, () => console.log(`🚀 LegoTracker V11.2 online na porta ${PORT}`));
