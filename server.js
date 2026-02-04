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

// --- 1. CONFIGURAÇÃO EMAIL ---
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER) {
        console.log(`📨 [DEV EMAIL] Para: ${to} | ${subject}\n${text}`);
        return;
    }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

// --- 2. CONFIGURAÇÃO PASSPORT ---
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return done(err);
        if (!user) return done(null, false, { message: 'Email desconhecido.' });
        if (!user.password) return done(null, false, { message: 'Use Google Login.' });
        try {
            if (await bcrypt.compare(password, user.password)) {
                if (user.is_verified === 0) return done(null, false, { message: 'Email não verificado.' });
                return done(null, user);
            }
            return done(null, false, { message: 'Password errada.' });
        } catch(e) { return done(e); }
    });
}));

// Configuração Google (Sempre ativa para evitar erro 404)
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
                return done(null, user);
            }
            db.run("INSERT INTO users (name, email, google_id, is_verified) VALUES (?, ?, ?, 1)", 
                [profile.displayName, email, googleId], function(err) {
                if(this.lastID === 1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                done(null, { id: this.lastID, name: profile.displayName, email });
            });
        });
    }));
}

// --- 3. MIDDLEWARES ---
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

// --- 4. ROTA PRINCIPAL ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : null;
    let { themes, year, search, page, limit } = req.query;

    let limitVal = limit || (req.user ? req.user.items_per_page : 25);
    if (limitVal === 'all') limitVal = 10000;
    let pageVal = parseInt(page) || 1;
    let offset = (pageVal - 1) * limitVal;

    let whereClause = "WHERE 1=1";
    let sqlParams = [];

    if (themes) {
        const themeList = Array.isArray(themes) ? themes : [themes];
        whereClause += ` AND themes.name IN (${themeList.map(() => '?').join(',')})`;
        sqlParams.push(...themeList);
    }
    if (year) { whereClause += " AND sets.year = ?"; sqlParams.push(year); }
    if (search) { whereClause += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; sqlParams.push(`%${search}%`, `%${search}%`); }

    // Filtro visitante padrão
    if (req.user && !themes && !year && !search) {
        whereClause += " AND user_sets.user_id = ?";
        sqlParams.push(userId);
    }

    // QUERY 1: Contagem
    let countSql = `
        SELECT COUNT(*) as total 
        FROM sets 
        LEFT JOIN themes ON sets.theme_id = themes.id 
        LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? 
        ${whereClause}
    `;
    
    db.get(countSql, [userId, ...sqlParams], (err, row) => {
        const totalItems = row ? row.total : 0;
        const totalPages = Math.ceil(totalItems / limitVal);

        // QUERY 2: Dados (Ordenação Corrigida)
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
            
            // QUERY 3: Sidebar (CORREÇÃO: GROUP BY NAME para evitar duplicados)
            let themesSql = `
                SELECT themes.name, MIN(sets.year) as min_year, MAX(sets.year) as max_year
                FROM themes
                JOIN sets ON themes.id = sets.theme_id
                GROUP BY themes.name
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

// --- 5. ROTAS DE AUTENTICAÇÃO ---
app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login?error=Credenciais inválidas' }));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// ROTA GOOGLE - AGORA FORA DO BLOCO IF PARA EVITAR "Cannot GET"
app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
        return res.status(500).send("<h1>Erro de Configuração</h1><p>GOOGLE_CLIENT_ID não encontrado no ficheiro .env</p>");
    }
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login?error=Falha no Login Google' }),
    (req, res) => res.redirect('/')
);

// Rota de Registo Local
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const exists = await new Promise(r => db.get("SELECT id FROM users WHERE email=?", [email], (e,row)=>r(row)));
        if(exists) return res.redirect('/login?error=Email já existe');
        
        const hashed = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        
        db.run("INSERT INTO users (name,email,password,is_verified,verify_token) VALUES (?,?,?,0,?)", [name,email,hashed,token], function(err){
            if(err) return res.redirect('/login?error=Erro ao registar');
            sendEmail(email, "Ativar Conta", `Link: http://${req.headers.host}/verify/${token}`);
            
            if(this.lastID===1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned=1");
            res.redirect('/login?success=Registo efetuado. Verifique o seu email (ou consola).');
        });
    } catch(e) { res.redirect('/login?error=Erro no servidor'); }
});

app.get('/verify/:token', (req, res) => {
    db.get("SELECT id FROM users WHERE verify_token=?", [req.params.token], (e,u) => {
        if(!u) return res.redirect('/login?error=Token inválido');
        db.run("UPDATE users SET is_verified=1, verify_token=NULL WHERE id=?", [u.id], ()=> res.redirect('/login?success=Conta ativada!'));
    });
});

// --- 6. API E CRON ---
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
    if(u.length) { sql+=u.join(",")+" WHERE id=?"; p.push(req.user.id); db.run(sql,p,()=>res.json({ok:true})); }
    else res.json({ok:true});
});

cron.schedule('0 4 * * *', () => exec('node sync.js', (e, out) => console.log(out || e)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
