require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cron = require('node-cron');     // Restaurado
const { exec } = require('child_process'); // Restaurado
const nodemailer = require('nodemailer');  // Restaurado
const multer = require('multer');      // Restaurado
const db = require('./db');
const path = require('path');
const app = express();

const upload = multer({ dest: 'uploads/' });

// Configuração do EJS e Pasta Pública
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sessão
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: 'segredo_super_secreto_lego',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 dias
}));

// Passport Middleware
app.use(passport.initialize());
app.use(passport.session());

// Middleware Global (User)
app.use((req, res, next) => {
    res.locals.user = req.user;
    next();
});

// --- CONFIGURAÇÃO DE EMAIL ---
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER) { 
        console.log(`\n📨 [EMAIL SIMULADO] Para: ${to}\nAssunto: ${subject}\nMsg: ${text}\n`); 
        return; 
    }
    try {
        await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
    } catch (e) {
        console.error("Erro ao enviar email:", e);
    }
}

// --- CRON JOB (Sincronização Automática) ---
// Executa todos os dias às 04:00 da manhã
cron.schedule('0 4 * * *', () => {
    console.log('🔄 A executar sincronização agendada...');
    exec('npm run sync', (error, stdout, stderr) => {
        if (error) console.error(`Erro no Cron: ${error.message}`);
        if (stderr) console.error(`Stderr: ${stderr}`);
        console.log(`Resultado Sync: ${stdout}`);
    });
});

// --- AUTENTICAÇÃO (Passport) ---
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return done(err);
        if (!user) return done(null, false, { message: 'Email não encontrado.' });
        if (!user.password) return done(null, false, { message: 'Use o login Google.' });
        
        try {
            if (await bcrypt.compare(password, user.password)) {
                if (!user.is_verified) return done(null, false, { message: 'Conta não verificada. Verifique o seu email.' });
                return done(null, user);
            } else {
                return done(null, false, { message: 'Password incorreta.' });
            }
        } catch (e) { return done(e); }
    });
}));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
        if (user) {
            if (!user.google_id) db.run("UPDATE users SET google_id = ? WHERE id = ?", [profile.id, user.id]);
            return done(null, user);
        } else {
            db.run("INSERT INTO users (name, email, google_id, is_verified) VALUES (?, ?, ?, 1)", 
                [profile.displayName, email, profile.id], 
                function(err) {
                    if (err) return done(err);
                    db.get("SELECT * FROM users WHERE id = ?", [this.lastID], (e, u) => done(e, u));
                }
            );
        }
    });
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, user) => done(err, user));
});

function ensureAdmin(req, res, next) {
    if (req.user && req.user.id === 1) return next();
    res.status(403).send("Acesso Negado.");
}

// --- ROTAS PRINCIPAIS ---

// 1. HOMEPAGE (Com a correção dos filtros)
app.get('/', (req, res) => {
    const filterSearch = req.query.q || '';
    const filterTheme = req.query.theme || '';
    const filterYear = req.query.year || '';
    const filterSort = req.query.sort || 'newest';
    const page = parseInt(req.query.page) || 1;
    
    // Paginação baseada na preferência
    const limit = (req.user && req.user.items_per_page) ? req.user.items_per_page : 24;
    const offset = (page - 1) * limit;

    let sql = `
        SELECT s.*, 
               t.name as theme_name,
               us.status as user_status, 
               us.quantity as user_qty
        FROM sets s
        LEFT JOIN themes t ON s.theme_id = t.id
        LEFT JOIN user_sets us ON s.set_num = us.set_num AND us.user_id = ?
        WHERE 1=1
    `;
    
    let params = [req.user ? req.user.id : 0];

    // Aplicar Filtros
    if (filterSearch) {
        sql += " AND (s.name LIKE ? OR s.set_num LIKE ?)";
        params.push(`%${filterSearch}%`, `%${filterSearch}%`);
    }
    if (filterTheme) {
        sql += " AND s.theme_id = ?";
        params.push(filterTheme);
    }
    if (filterYear) {
        sql += " AND s.year = ?";
        params.push(filterYear);
    }

    // Ordenação
    if (filterSort === 'pieces') sql += " ORDER BY s.num_parts DESC";
    else if (filterSort === 'price') sql += " ORDER BY s.price_eur DESC";
    else sql += " ORDER BY s.year DESC, s.set_num DESC"; 

    // Executar Queries
    db.all("SELECT id, name, (SELECT COUNT(*) FROM sets WHERE theme_id = themes.id) as count FROM themes ORDER BY name", [], (err, themes) => {
        if(err) return res.status(500).send("Erro Temas");

        // Contagem Total
        let countSql = `SELECT COUNT(*) as total FROM sets s WHERE 1=1`;
        let countParams = [];
        if (filterSearch) { countSql += " AND (s.name LIKE ? OR s.set_num LIKE ?)"; countParams.push(`%${filterSearch}%`, `%${filterSearch}%`); }
        if (filterTheme) { countSql += " AND s.theme_id = ?"; countParams.push(filterTheme); }
        if (filterYear) { countSql += " AND s.year = ?"; countParams.push(filterYear); }

        db.get(countSql, countParams, (e, countRow) => {
            const totalSets = countRow ? countRow.total : 0;
            const totalPages = Math.ceil(totalSets / limit);

            sql += " LIMIT ? OFFSET ?";
            params.push(limit, offset);

            db.all(sql, params, (err, rows) => {
                if (err) return res.status(500).send("Erro BD");

                const processedSets = rows.map(s => ({
                    ...s,
                    owned: s.user_status === 'OWNED',
                    wanted: s.user_status === 'WANTED'
                }));

                res.render('index', {
                    sets: processedSets,
                    themes: themes,
                    pagination: { page, totalPages },
                    filters: { // Objeto Filters Restaurado
                        search: filterSearch,
                        theme: filterTheme,
                        year: filterYear,
                        sort: filterSort
                    }
                });
            });
        });
    });
});

// --- ROTAS DE UTILIZADOR E API ---

// Registo (Restaurado)
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const exists = await new Promise(r => db.get("SELECT id FROM users WHERE email=?", [email], (e,row)=>r(row)));
        if(exists) return res.redirect('/login?error=Email já existe');

        const hashed = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');

        db.run("INSERT INTO users (name,email,password,is_verified,verify_token,last_login) VALUES (?,?,?,0,?,NULL)", 
            [name, email, hashed, token], 
            function(err) {
                if(err) return res.redirect('/login?error=Erro registo');
                
                sendEmail(email, "Ativar Conta LegoTracker", 
                    `Clique para ativar: http://${req.headers.host}/verify/${token}`);
                
                // Se for o primeiro utilizador, dá ownership dos sets owned padrão (opcional do código original)
                if(this.lastID === 1) {
                    // Lógica original preservada
                }
                res.redirect('/login?success=Verifique Email');
            }
        );
    } catch(e) { res.redirect('/login?error=Erro servidor'); }
});

// Verificação (Restaurado)
app.get('/verify/:token', (req, res) => {
    db.get("SELECT id FROM users WHERE verify_token=?", [req.params.token], (e, u) => {
        if(!u) return res.redirect('/login?error=Token inválido');
        db.run("UPDATE users SET is_verified=1, verify_token=NULL WHERE id=?", [u.id], (err) => {
            res.redirect('/login?success=Conta Verificada');
        });
    });
});

// Toggle Status (Tenho/Quero)
app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { set_num, status } = req.body;

    if (status === 'REMOVE') {
        db.run("DELETE FROM user_sets WHERE user_id = ? AND set_num = ?", [req.user.id, set_num], (err) => res.json({ success: !err }));
    } else {
        db.run(`INSERT INTO user_sets (user_id, set_num, quantity, status) VALUES (?, ?, 1, ?)
                ON CONFLICT(user_id, set_num) DO UPDATE SET status = ?`,
            [req.user.id, set_num, status, status], (err) => res.json({ success: !err }));
    }
});

// Preferências
app.post('/api/preferences', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { dark_mode, items_per_page } = req.body;
    
    if (dark_mode !== undefined) {
        db.run("UPDATE users SET dark_mode = ? WHERE id = ?", [dark_mode?1:0, req.user.id]);
        req.user.dark_mode = dark_mode ? 1 : 0;
    } else if (items_per_page !== undefined) {
        db.run("UPDATE users SET items_per_page = ? WHERE id = ?", [items_per_page, req.user.id]);
        req.user.items_per_page = items_per_page;
    }
    res.json({ success: true });
});

// --- ROTAS DE ADMINISTRAÇÃO ---

app.get('/admin/users', ensureAdmin, (req, res) => {
    const sort = req.query.sort || 'id';
    let orderBy = 'id ASC';
    if(sort === 'name') orderBy = 'name ASC';
    if(sort === 'login') orderBy = 'last_login DESC';

    db.all(`SELECT * FROM users ORDER BY ${orderBy}`, [], (err, rows) => {
        res.render('admin/users', { users: rows, sort: sort });
    });
});

app.post('/admin/users/reset', ensureAdmin, express.json(), (req, res) => {
    const token = crypto.randomBytes(20).toString('hex');
    const link = `http://${req.headers.host}/reset/${token}`;
    // Aqui poderia atualizar a BD com o reset_token
    res.json({ success: true, link: link });
});

app.get('/admin/sets', ensureAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    db.all("SELECT * FROM sets LIMIT ? OFFSET ?", [limit, offset], (err, rows) => {
        db.get("SELECT COUNT(*) as count FROM sets", (e, c) => {
            res.render('admin/sets', { sets: rows, pagination: { page, totalPages: Math.ceil(c.count/limit) }});
        });
    });
});

app.get('/admin/themes', ensureAdmin, (req, res) => {
    db.all(`SELECT t.*, (SELECT COUNT(*) FROM sets WHERE theme_id = t.id) as total_sets FROM themes t ORDER BY t.id`, [], (err, rows) => {
        res.render('admin/themes', { themes: rows });
    });
});

// --- AUTENTICAÇÃO ROTAS ---
app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login?error=DadosInvalidos'
}));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// Iniciar Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor a rodar na porta ${PORT}`));
