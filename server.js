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
        console.log(`\n📨 [DEV EMAIL SIMULADO] Para: ${to}`);
        console.log(`📝 Assunto: ${subject}`);
        console.log(`🔗 Conteúdo:\n${text}\n`);
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
        if (!user) return done(null, false, { message: 'Email não registado.' });
        if (!user.password) return done(null, false, { message: 'Esta conta usa Login Google.' });
        
        try {
            if (await bcrypt.compare(password, user.password)) {
                // VERIFICAÇÃO DE EMAIL
                if (user.is_verified === 0) {
                    return done(null, false, { message: 'Conta não ativada. Verifique o seu email (ou consola).' });
                }
                return done(null, user);
            }
            return done(null, false, { message: 'Password incorreta.' });
        } catch(e) { return done(e); }
    });
}));

// Configuração Google
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

    if (req.user && !themes && !year && !search) {
        whereClause += " AND user_sets.user_id = ?";
        sqlParams.push(userId);
    }

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

// --- 5. ROTAS DE AUTENTICAÇÃO (CORRIGIDAS) ---
app.get('/login', (req, res) => res.render('login'));

// ROTA DE LOGIN CORRIGIDA: Agora captura a mensagem exata do erro
app.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) { return next(err); }
        if (!user) { 
            // Redireciona com a mensagem ESPECÍFICA (ex: Conta não ativada)
            return res.redirect('/login?error=' + encodeURIComponent(info.message || 'Erro no login')); 
        }
        req.logIn(user, (err) => {
            if (err) { return next(err); }
            return res.redirect('/');
        });
    })(req, res, next);
});

app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// Google
app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send("Erro: GOOGLE_CLIENT_ID não configurado.");
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login?error=Falha Google' }),
    (req, res) => res.redirect('/')
);

// Registo
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const exists = await new Promise(r => db.get("SELECT id FROM users WHERE email=?", [email], (e,row)=>r(row)));
        if(exists) return res.redirect('/login?error=Email já existe');
        
        const hashed = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        
        db.run("INSERT INTO users (name,email,password,is_verified,verify_token) VALUES (?,?,?,0,?)", [name,email,hashed,token], function(err){
            if(err) return res.redirect('/login?error=Erro ao registar');
            
            // Envia Email (ou Log)
            sendEmail(email, "Ativar Conta LegoTracker", `Clique aqui para ativar: http://${req.headers.host}/verify/${token}`);
            
            if(this.lastID===1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned=1");
            res.redirect('/login?success=Registo efetuado! Verifique a sua caixa de correio (ou o terminal do servidor).');
        });
    } catch(e) { res.redirect('/login?error=Erro no servidor'); }
});

app.get('/verify/:token', (req, res) => {
    db.get("SELECT id FROM users WHERE verify_token=?", [req.params.token], (e,u) => {
        if(!u) return res.redirect('/login?error=Link inválido ou expirado.');
        db.run("UPDATE users SET is_verified=1, verify_token=NULL WHERE id=?", [u.id], ()=> res.redirect('/login?success=Conta ativada com sucesso!'));
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
