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
const app = express();

// --- EMAIL ---
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER) {
        console.log(`\n📨 [EMAIL SIMULADO] Para: ${to}\nAssunto: ${subject}\nConteúdo: ${text}\n`);
        return;
    }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

// --- MIDDLEWARE ADMIN ---
function ensureAdmin(req, res, next) {
    if (req.user && req.user.id === 1) return next();
    res.status(403).send("<h1>403 Acesso Negado</h1><p>Apenas o Administrador (ID 1) pode ver esta página.</p>");
}

// --- PASSPORT ---
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page, google_id FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

function updateLastLogin(user) {
    db.run("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
}

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
    }));
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
                if(this.lastID === 1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                done(null, { id: this.lastID, name: profile.displayName, email });
            });
        });
    }));
}

// --- MIDDLEWARES GERAIS ---
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

// --- ROTA PRINCIPAL (COM FILTRO DE OCULTOS) ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : null;
    let { themes, year, search, page, limit } = req.query;

    let limitVal = limit || (req.user ? req.user.items_per_page : 25);
    if (limitVal === 'all') limitVal = 10000;
    let pageVal = parseInt(page) || 1;
    let offset = (pageVal - 1) * limitVal;

    // FILTRO DE SEGURANÇA: Não mostrar temas ocultos (is_hidden) na homepage
    let whereClause = "WHERE (themes.is_hidden IS NULL OR themes.is_hidden = 0)";
    let sqlParams = [];

    if (themes) {
        const themeList = Array.isArray(themes) ? themes : [themes];
        whereClause += ` AND themes.name IN (${themeList.map(() => '?').join(',')})`;
        sqlParams.push(...themeList);
    }
    if (year) { whereClause += " AND sets.year = ?"; sqlParams.push(year); }
    if (search) { whereClause += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; sqlParams.push(`%${search}%`, `%${search}%`); }

    if (req.user && !themes && !year && !search) {
        whereClause += " AND user_sets.user_id = ?";
        sqlParams.push(userId);
    }

    let countSql = `SELECT COUNT(*) as total FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${whereClause}`;
    
    db.get(countSql, [userId, ...sqlParams], (err, row) => {
        const totalItems = row ? row.total : 0;
        const totalPages = Math.ceil(totalItems / limitVal);

        let dataSql = `SELECT sets.*, themes.name as theme_name, CASE WHEN user_sets.user_id IS NOT NULL THEN 1 ELSE 0 END as is_owned FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${whereClause} ORDER BY themes.name ASC, sets.year DESC LIMIT ? OFFSET ?`;

        db.all(dataSql, [userId, ...sqlParams, limitVal, offset], (err, sets) => {
            // Sidebar: Apenas temas visíveis
            let themesSql = `
                SELECT themes.name, MIN(sets.year) as min_year, MAX(sets.year) as max_year
                FROM themes
                JOIN sets ON themes.id = sets.theme_id
                WHERE (themes.is_hidden IS NULL OR themes.is_hidden = 0)
                GROUP BY themes.name ORDER BY themes.name ASC
            `;

            db.all(themesSql, [], (e1, allThemes) => {
                db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => {
                    res.render('index', { 
                        sets: sets || [], allThemes: allThemes || [], allYears: allYears || [], 
                        query: req.query, pagination: { page: pageVal, limit: limit || (req.user?.items_per_page || 25), totalPages, totalItems },
                        user: req.user, currentYear: new Date().getFullYear()
                    });
                });
            });
        });
    });
});

// --- ÁREA DE ADMINISTRAÇÃO ---

// 1. Dashboard de Temas
app.get('/admin/themes', ensureAdmin, (req, res) => {
    const sql = `
        SELECT t.id, t.name, t.is_hidden, t.ignore_parts,
               COUNT(s.set_num) as total_sets,
               SUM(CASE WHEN s.num_parts = 0 THEN 1 ELSE 0 END) as zero_part_sets,
               MIN(s.year) as min_year, MAX(s.year) as max_year
        FROM themes t
        LEFT JOIN sets s ON t.id = s.theme_id
        GROUP BY t.id
        ORDER BY t.name ASC
    `;
    db.all(sql, [], (err, themes) => {
        res.render('admin/themes', { themes: themes || [], user: req.user });
    });
});

// API para ligar/desligar flags dos temas
app.post('/admin/themes/toggle', ensureAdmin, (req, res) => {
    const { theme_id, field, value } = req.body;
    if (!['is_hidden', 'ignore_parts'].includes(field)) return res.status(400).send();
    db.run(`UPDATE themes SET ${field} = ? WHERE id = ?`, [value ? 1 : 0, theme_id], (err) => {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

// 2. Dashboard de Utilizadores
app.get('/admin/users', ensureAdmin, (req, res) => {
    let { sort } = req.query;
    let orderBy = "id ASC";
    if (sort === 'name') orderBy = "name ASC";
    if (sort === 'login') orderBy = "google_id DESC";
    if (sort === 'access') orderBy = "last_login DESC";

    const sql = `SELECT id, name, email, google_id, is_verified, last_login FROM users ORDER BY ${orderBy}`;
    db.all(sql, [], (err, users) => {
        res.render('admin/users', { users: users || [], sort, user: req.user });
    });
});

// Reset Password - Admin
app.post('/admin/users/reset', ensureAdmin, async (req, res) => {
    const { user_id, type } = req.body;
    db.get("SELECT * FROM users WHERE id = ?", [user_id], (err, user) => {
        if (!user || user.google_id) return res.json({error: "Utilizador inválido ou usa Google Login."});
        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 3600000;
        
        db.run("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?", [token, expires, user_id], async (e) => {
            const link = `http://${req.headers.host}/reset/${token}`;
            if (type === 'email') {
                await sendEmail(user.email, "Reset Password (Admin)", `O administrador gerou um reset.\nLink: ${link}`);
                res.json({success: true, message: "Email enviado."});
            } else {
                res.json({success: true, link: link});
            }
        });
    });
});

// --- ROTAS DE AUTH & CRON ---
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) return res.redirect('/login?error=' + encodeURIComponent(info.message || 'Erro'));
        req.logIn(user, (err) => { if (err) return next(err); res.redirect('/'); });
    })(req, res, next);
});
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });
app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send("Google ID em falta.");
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login?error=Falha Google' }), (req, res) => res.redirect('/'));
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const exists = await new Promise(r => db.get("SELECT id FROM users WHERE email=?", [email], (e,row)=>r(row)));
        if(exists) return res.redirect('/login?error=Email já existe');
        const hashed = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        db.run("INSERT INTO users (name,email,password,is_verified,verify_token,last_login) VALUES (?,?,?,0,?,NULL)", [name,email,hashed,token], function(err){
            if(err) return res.redirect('/login?error=Erro registo');
            sendEmail(email, "Ativar Conta", `Link: http://${req.headers.host}/verify/${token}`);
            if(this.lastID===1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned=1");
            res.redirect('/login?success=Verifique Email');
        });
    } catch(e) { res.redirect('/login?error=Erro servidor'); }
});
app.get('/verify/:token', (req, res) => {
    db.get("SELECT id FROM users WHERE verify_token=?", [req.params.token], (e,u) => {
        if(!u) return res.redirect('/login?error=Token inválido');
        db.run("UPDATE users SET is_verified=1, verify_token=NULL WHERE id=?", [u.id], ()=> res.redirect('/login?success=Ativado!'));
    });
});
app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    const q = req.body.active ? "INSERT OR IGNORE INTO user_sets (user_id, set_num) VALUES (?,?)" : "DELETE FROM user_sets WHERE user_id=? AND set_num=?";
    db.run(q, [req.user.id, req.body.set_num], () => res.json({ok:true}));
});
app.post('/api/preferences', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { dark_mode, items_per_page } = req.body;
    let sql="UPDATE users SET ", p=[], u=[];
    if(dark_mode!==undefined) {u.push("dark_mode=?"); p.push(dark_mode?1:0);}
    if(items_per_page!==undefined) {u.push("items_per_page=?"); p.push(items_per_page);}
    if(u.length) { sql+=u.join(",")+" WHERE id=?"; p.push(req.user.id); db.run(sql,p,()=>res.json({ok:true})); } else res.json({ok:true});
});
cron.schedule('0 4 * * *', () => exec('node sync.js', (e, out) => console.log(out || e)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
