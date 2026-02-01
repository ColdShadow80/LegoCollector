require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const db = require('./db'); // Usa o novo gestor
const app = express();

// --- CONFIGURAÇÃO PASSPORT ---
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user || !user.password) return done(null, false);
        if (await bcrypt.compare(password, user.password)) return done(null, user);
        return done(null, false);
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
            if (user) return done(null, user);
            db.run("INSERT INTO users (name, email, google_id) VALUES (?, ?, ?)", 
                [profile.displayName, email, googleId], function(err) {
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
    secret: process.env.SESSION_SECRET || 'segredo_padrao',
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 dias
}));
app.use(passport.initialize());
app.use(passport.session());

// --- LÓGICA CORE DE VISUALIZAÇÃO ---
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : null;
    let { theme, year, search } = req.query;
    const currentYear = new Date().getFullYear();
    
    // Variável para controlar a mensagem de feedback no topo
    let viewMode = 'default'; 

    let sql = `
        SELECT sets.*, themes.name as theme_name, 
        CASE WHEN user_sets.user_id IS NOT NULL THEN 1 ELSE 0 END as is_owned
        FROM sets 
        LEFT JOIN themes ON sets.theme_id = themes.id 
        LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? 
        WHERE 1=1
    `;
    let params = [userId];

    // LÓGICA DE FILTRAGEM AUTOMÁTICA
    const hasFilters = theme || year || search;

    if (!userId) {
        // --- VISITANTE ---
        if (!hasFilters) {
            // Se não filtrar nada, mostra só o ano atual para não pesar
            sql += " AND sets.year = ?";
            params.push(currentYear);
            viewMode = 'visitor_home';
        }
    } else {
        // --- UTILIZADOR LOGADO ---
        if (!hasFilters) {
            // Por defeito, mostra A MINHA COLEÇÃO
            sql += " AND user_sets.user_id = ?";
            params.push(userId);
            viewMode = 'my_collection';
        } else {
            // Se está a procurar, procura na BASE GLOBAL (mas mantém flags de coleção)
            viewMode = 'global_search';
        }
    }

    // Aplicação dos Filtros Manuais
    if (theme) { sql += " AND themes.name LIKE ?"; params.push(`%${theme}%`); }
    if (year) { sql += " AND sets.year = ?"; params.push(year); }
    if (search) { sql += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }

    sql += " ORDER BY sets.year DESC, sets.name ASC LIMIT 300";

    db.all(sql, params, (err, sets) => {
        if(err) console.error(err);
        
        // Carrega dropdowns
        db.all("SELECT DISTINCT name FROM themes ORDER BY name", [], (e1, themes) => {
            db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, years) => {
                res.render('index', { 
                    sets, themes, years, 
                    query: req.query, 
                    user: req.user,
                    currentYear,
                    viewMode // Passamos o modo para o EJS saber o que escrever
                });
            });
        });
    });
});

// --- ROTAS DE AÇÃO ---
app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login' }));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

app.post('/register', async (req, res) => {
    try {
        const hashed = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", 
            [req.body.name, req.body.email, hashed], 
            function(err) {
                if(err) return res.redirect('/login?err=exists');
                // Migração de Legado: Se existiam sets "owned" no sistema antigo sem dono,
                // atribui-os ao primeiro utilizador que se registar.
                if (this.lastID === 1) {
                   db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                }
                res.redirect('/login');
            });
    } catch (e) { res.redirect('/login'); }
});

app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { set_num, active } = req.body;
    const query = active 
        ? "INSERT OR IGNORE INTO user_sets (user_id, set_num) VALUES (?, ?)"
        : "DELETE FROM user_sets WHERE user_id = ? AND set_num = ?";
    db.run(query, [req.user.id, set_num], () => res.json({ok: true}));
});

// Google Auth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => res.redirect('/'));

app.listen(3000, () => console.log('🚀 Servidor iniciado.'));
