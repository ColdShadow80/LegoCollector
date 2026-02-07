require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const cron = require('node-cron');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('./db');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const axios = require('axios');
const app = express();

const upload = multer({ dest: 'uploads/' });

// Email Config
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER) { console.log(`\n📨 [EMAIL SIMULADO] Para: ${to}\n${text}\n`); return; }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

function ensureAdmin(req, res, next) { if (req.user && req.user.id === 1) return next(); res.status(403).send("Acesso Negado."); }

// Passport Config
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page, google_id FROM users WHERE id = ?", [id], (err, row) => {
        if (err) return done(err);
        if (!row) return done(null, false);
        done(null, row);
    });
});

function updateLastLogin(user) { db.run("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [user.id]); }

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return done(null, false, { message: 'Credenciais inválidas.' });
        if (!user.password) return done(null, false, { message: 'Use Google Login.' });
        if (await bcrypt.compare(password, user.password)) {
            if (user.is_verified === 0) return done(null, false, { message: 'Conta não ativada.' });
            updateLastLogin(user);
            return done(null, user);
        }
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
        const googleId = profile.id;
        db.get("SELECT * FROM users WHERE google_id = ? OR email = ?", [googleId, email], (err, user) => {
            if (user) {
                if (user.is_verified === 0) db.run("UPDATE users SET is_verified = 1 WHERE id = ?", [user.id]);
                updateLastLogin(user);
                return done(null, user);
            }
            db.run("INSERT INTO users (name, email, google_id, is_verified, last_login) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)", 
                [profile.displayName, email, googleId], function(err) {
                done(null, { id: this.lastID, name: profile.displayName, email });
            });
        });
    }));
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: process.env.SESSION_SECRET || 'dev_secret',
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 3600000 }
}));
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
    res.locals.error = req.query.error;
    res.locals.success = req.query.success;
    res.locals.user = req.user;
    next();
});

const dbGet = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if(err) reject(err); else resolve(row); });
});

function buildFilters(query, userId, isAdminView = false) {
    let { themes, year, search, status } = query;
    let whereClause = "WHERE 1=1";
    let params = [];
    if (themes) { const list = Array.isArray(themes) ? themes : [themes]; whereClause += ` AND themes.name IN (${list.map(() => '?').join(',')})`; params.push(...list); }
    if (year) { whereClause += " AND sets.year = ?"; params.push(year); }
    if (search) { whereClause += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
    if (!isAdminView) {
        whereClause += " AND (themes.is_hidden IS NULL OR themes.is_hidden = 0) AND (sets.is_hidden IS NULL OR sets.is_hidden = 0)";
        if (userId && status === 'owned') { whereClause += " AND user_sets.user_id = ? AND user_sets.status = 'OWNED'"; params.push(userId); }
        else if (userId && status === 'wanted') { whereClause += " AND user_sets.user_id = ? AND user_sets.status = 'WANTED'"; params.push(userId); }
    }
    return { whereClause, params };
}

// ROTAS API SCANNER
app.get('/api/scan', async (req, res) => {
    if (!req.user) return res.status(401).send();
    const { code } = req.query;
    const cleanCode = code.trim();
    let foundSetNum = null;

    try {
        const localMatch = await dbGet("SELECT set_num FROM barcodes WHERE code = ?", [cleanCode]);
        if (localMatch) {
            foundSetNum = localMatch.set_num;
        } else if (cleanCode.length < 8) {
            foundSetNum = cleanCode.includes('-') ? cleanCode : `${cleanCode}-1`;
        } else {
            // APIs externas (Rebrickable/Brickset)
            const rbUrl = `https://rebrickable.com/api/v3/lego/sets/?search=${cleanCode}&page_size=1`;
            const rbRes = await axios.get(rbUrl, { headers: { 'Authorization': `key ${process.env.REBRICKABLE_API_KEY}` }});
            if (rbRes.data.results && rbRes.data.results.length > 0) foundSetNum = rbRes.data.results[0].set_num;
        }

        if (foundSetNum) {
            const detailsUrl = `https://rebrickable.com/api/v3/lego/sets/${foundSetNum}/`;
            const detailsRes = await axios.get(detailsUrl, { headers: { 'Authorization': `key ${process.env.REBRICKABLE_API_KEY}` }});
            const set = detailsRes.data;
            const row = await dbGet("SELECT status FROM user_sets WHERE user_id = ? AND set_num = ?", [req.user.id, set.set_num]);
            res.json({ found: true, set: { set_num: set.set_num, name: set.name, year: set.year, img_url: set.set_img_url, user_status: row ? row.status : null }});
        } else res.json({ found: false, scanned_code: cleanCode });
    } catch (e) { res.json({ found: false }); }
});

app.post('/api/scan/associate', (req, res) => {
    if (!req.user) return res.status(401).send();
    db.run("INSERT OR REPLACE INTO barcodes (code, set_num) VALUES (?, ?)", [req.body.barcode, req.body.set_num], () => res.json({success: true}));
});

// DASHBOARD
app.get('/dashboard', (req, res) => {
    if (!req.user) return res.redirect('/login');
    const u = req.user.id;
    const q1 = new Promise(r => db.get(`SELECT COUNT(*) as total_sets, SUM(quantity) as total_items, SUM(sets.num_parts * user_sets.quantity) as total_parts, COALESCE(SUM(user_sets.purchase_price * user_sets.quantity), 0) as total_spent, COALESCE(SUM(sets.price_eur * user_sets.quantity), 0) as total_value_rrp FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'OWNED'`, [u], (e, row) => r(row)));
    const q2 = new Promise(r => db.get(`SELECT COUNT(*) as wanted_count, COALESCE(SUM(sets.price_eur), 0) as wanted_value FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'WANTED'`, [u], (e, row) => r(row)));
    const q3 = new Promise(r => db.all(`SELECT themes.name, COUNT(*) as count FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num JOIN themes ON sets.theme_id = themes.id WHERE user_sets.user_id = ? AND user_sets.status = 'OWNED' GROUP BY themes.name ORDER BY count DESC LIMIT 5`, [u], (e, rows) => r(rows)));
    const q4 = new Promise(r => db.all(`SELECT sets.year, COUNT(*) as count FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_sets.user_id = ? AND user_sets.status = 'OWNED' GROUP BY sets.year ORDER BY sets.year ASC`, [u], (e, rows) => r(rows)));
    Promise.all([q1, q2, q3, q4]).then(([stats, wishlist, themes, years]) => {
        res.render('dashboard', { stats: stats || {}, wishlist: wishlist || {}, themes: themes || [], years: years || [], user: req.user });
    });
});

// ADMIN THEMES (CORRIGIDO COM SOMA DE PEÇAS)
app.get('/admin/themes', ensureAdmin, (req, res) => {
    const sql = `
        SELECT t.id, t.name, t.is_hidden, t.ignore_parts, 
        COUNT(s.set_num) as total_sets, 
        SUM(CASE WHEN s.num_parts = 0 THEN 1 ELSE 0 END) as zero_part_sets, 
        COALESCE(SUM(s.num_parts), 0) as total_parts,
        MIN(s.year) as min_year, MAX(s.year) as max_year 
        FROM themes t LEFT JOIN sets s ON t.id = s.theme_id 
        GROUP BY t.id ORDER BY t.name ASC`;
    db.all(sql, [], (err, themes) => res.render('admin/themes', { themes: themes || [], user: req.user }));
});

// ADMIN USERS
app.get('/admin/users', ensureAdmin, (req, res) => {
    let orderBy = "id ASC";
    if (req.query.sort === 'name') orderBy = "name ASC";
    else if (req.query.sort === 'login') orderBy = "google_id DESC";
    else if (req.query.sort === 'access') orderBy = "last_login DESC";
    db.all(`SELECT * FROM users ORDER BY ${orderBy}`, [], (err, users) => res.render('admin/users', { users: users || [], sort: req.query.sort, user: req.user }));
});

app.post('/api/preferences', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { dark_mode, items_per_page } = req.body;
    let updates = []; let params = [];
    if(dark_mode !== undefined) { updates.push("dark_mode = ?"); params.push(dark_mode ? 1 : 0); }
    if(items_per_page !== undefined) { updates.push("items_per_page = ?"); params.push(items_per_page); }
    params.push(req.user.id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, () => res.json({ok: true}));
});

// INDEX
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : null;
    let limitVal = parseInt(req.query.limit) || (req.user ? req.user.items_per_page : 25);
    let pageVal = parseInt(req.query.page) || 1;
    let offset = (pageVal - 1) * limitVal;
    const filter = buildFilters(req.query, userId);
    let sort = req.query.sort === 'year_desc' ? "sets.year DESC" : (req.query.sort === 'parts_desc' ? "sets.num_parts DESC" : "sets.name ASC");

    db.get(`SELECT COUNT(*) as total FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${filter.whereClause}`, [userId, ...filter.params], (err, row) => {
        const totalItems = row ? row.total : 0;
        db.all(`SELECT sets.*, themes.name as theme_name, user_sets.status as user_status FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${filter.whereClause} ORDER BY ${sort} LIMIT ? OFFSET ?`, [userId, ...filter.params, limitVal, offset], (err, sets) => {
            db.all("SELECT name FROM themes ORDER BY name ASC", [], (e1, allThemes) => {
                db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => {
                    res.render('index', { sets: sets || [], allThemes, allYears, query: req.query, pagination: { page: pageVal, limit: limitVal, totalPages: Math.ceil(totalItems/limitVal), totalItems }, user: req.user });
                });
            });
        });
    });
});

// SET DETAIL
app.get('/set/:set_num', (req, res) => {
    const u = req.user ? req.user.id : null;
    db.get(`SELECT sets.*, themes.name as theme_name, user_sets.status as user_status, user_sets.location, user_sets.build_status, user_sets.purchase_price, user_sets.date_added FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? WHERE sets.set_num = ?`, [u, req.params.set_num], (err, set) => {
        if (!set) return res.redirect('/');
        set.rb_url = `https://rebrickable.com/sets/${set.set_num}`;
        res.render('set_detail', { set, user: req.user });
    });
});

app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { set_num, status } = req.body;
    if (status === 'REMOVE') db.run("DELETE FROM user_sets WHERE user_id=? AND set_num=?", [req.user.id, set_num], () => res.json({ok: true}));
    else db.run("INSERT INTO user_sets (user_id, set_num, status) VALUES (?, ?, ?) ON CONFLICT(user_id, set_num) DO UPDATE SET status = excluded.status", [req.user.id, set_num, status], () => res.json({ok: true}));
});

app.post('/api/user_set/update', (req, res) => {
    if (!req.user) return res.status(401).send();
    db.run("UPDATE user_sets SET build_status = ?, location = ?, purchase_price = ? WHERE user_id = ? AND set_num = ?", [req.body.build_status, req.body.location, req.body.purchase_price, req.user.id, req.body.set_num], () => res.json({success: true}));
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login?error=1' }));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { successRedirect: '/', failureRedirect: '/login' }));

app.listen(3001, () => console.log("🚀 Servidor na porta 3001"));
