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
const nodemailer = require('nodemailer'); // NOVO
const crypto = require('crypto');         // NOVO
const db = require('./db');
const app = express();

// --- CONFIGURAÇÃO EMAIL (NODEMAILER) ---
// Se não houver variaveis no .env, os links aparecem na consola para teste
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail', // ex: 'gmail'
    auth: {
        user: process.env.EMAIL_USER,     // seu email
        pass: process.env.EMAIL_PASS      // sua app password (não a pass normal)
    }
});

// Função Auxiliar de Envio
async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER) {
        console.log(`\n📨 [SIMULAÇÃO EMAIL] Para: ${to} | Assunto: ${subject}`);
        console.log(`📝 Conteúdo: ${text}\n`);
        return;
    }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

// --- CONFIGURAÇÃO PASSPORT ---
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return done(err);
        if (!user) return done(null, false, { message: 'Email não registado.' });
        if (!user.password) return done(null, false, { message: 'Use o Google Login.' });
        
        // 1. Verificar Password
        try {
            if (await bcrypt.compare(password, user.password)) {
                // 2. Verificar Validação de Email
                if (user.is_verified === 0) {
                    return done(null, false, { message: 'Email não verificado. Verifique a sua caixa de entrada.' });
                }
                return done(null, user);
            }
            return done(null, false, { message: 'Password incorreta.' });
        } catch(e) { return done(e); }
    });
}));

// Google Strategy (mantido igual)
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
                // Se já existe, garante que está verificado (Google é confiável)
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

// --- MIDDLEWARES ---
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

// Middleware para passar mensagens de erro para as views (simples)
app.use((req, res, next) => {
    res.locals.error = req.query.error;
    res.locals.success = req.query.success;
    res.locals.user = req.user;
    next();
});

// --- ROTAS PRINCIPAIS ---
app.get('/', (req, res) => {
    // ... (MANTENHA A LÓGICA DA ROTA '/' DO CÓDIGO ANTERIOR AQUI - OMITIDA PARA POUPAR ESPAÇO) ...
    // ... Copie o conteúdo do app.get('/') da resposta anterior ...
    // Apenas para o MVP, vou redirecionar para login se não tiver lógica
    if (!req.query) res.render('login'); // Placeholder se não copiar
    else res.render('index', { sets: [], allThemes: [], allYears: [], query: {}, pagination: {}, user: req.user, currentYear: 2026 });
});

// --- ROTAS DE AUTENTICAÇÃO E EMAIL ---

// 1. LOGIN
app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { 
    successRedirect: '/', 
    failureRedirect: '/login?error=Dados incorretos ou email não validado' 
}));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// 2. REGISTO
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        // Verifica duplicados primeiro
        const exists = await new Promise((resolve) => {
            db.get("SELECT id FROM users WHERE email = ?", [email], (err, row) => resolve(row));
        });
        if (exists) return res.redirect('/login?error=Este email já existe.');

        const hashed = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex'); // Token de verificação

        db.run("INSERT INTO users (name, email, password, is_verified, verify_token) VALUES (?, ?, ?, 0, ?)", 
            [name, email, hashed, token], 
            function(err) {
                if (err) return res.redirect('/login?error=Erro ao registar.');

                // Envia Email
                const link = `http://${req.headers.host}/verify/${token}`;
                sendEmail(email, "Valide a sua conta LegoTracker", `Olá ${name},\n\nClique no link para ativar a sua conta:\n${link}`);

                // Se for o primeiro user, herda a coleção antiga
                if (this.lastID === 1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                
                res.redirect('/login?success=Registo efetuado! Verifique o seu email para ativar a conta.');
            });
    } catch (e) { res.redirect('/login?error=Erro no servidor'); }
});

// 3. VERIFICAR EMAIL
app.get('/verify/:token', (req, res) => {
    const token = req.params.token;
    db.get("SELECT id FROM users WHERE verify_token = ?", [token], (err, user) => {
        if (!user) return res.redirect('/login?error=Token inválido ou expirado.');
        
        db.run("UPDATE users SET is_verified = 1, verify_token = NULL WHERE id = ?", [user.id], (err) => {
            res.redirect('/login?success=Conta ativada! Pode fazer login.');
        });
    });
});

// 4. ESQUECI A PASSWORD (PEDIDO)
app.get('/forgot', (req, res) => res.render('forgot'));
app.post('/forgot', (req, res) => {
    const { email } = req.body;
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 3600000; // 1 hora

    db.get("SELECT id, name FROM users WHERE email = ?", [email], (err, user) => {
        if (!user) return res.redirect('/forgot?error=Email não encontrado.');

        db.run("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?", [token, expires, user.id], (err) => {
            const link = `http://${req.headers.host}/reset/${token}`;
            sendEmail(email, "Recuperação de Password", `Olá ${user.name},\n\nPara repor a password clique aqui:\n${link}\n\nLink válido por 1 hora.`);
            res.redirect('/login?success=Se o email existir, enviámos um link de recuperação.');
        });
    });
});

// 5. RESET PASSWORD (FORM E AÇÃO)
app.get('/reset/:token', (req, res) => {
    db.get("SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?", [req.params.token, Date.now()], (err, user) => {
        if (!user) return res.redirect('/login?error=Link expirado ou inválido.');
        res.render('reset', { token: req.params.token });
    });
});

app.post('/reset/:token', async (req, res) => {
    const { password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    
    db.get("SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?", [req.params.token, Date.now()], (err, user) => {
        if (!user) return res.redirect('/login?error=Link expirado.');

        db.run("UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?", [hashed, user.id], (err) => {
            res.redirect('/login?success=Password alterada com sucesso.');
        });
    });
});

// --- CRON E OUTRAS ROTAS API (MANTIDAS) ---
// (Coloque aqui o cron.schedule do código anterior...)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
