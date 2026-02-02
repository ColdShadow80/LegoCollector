require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const db = require('./db'); // Importa o gestor de base de dados e migrações
const app = express();

// --- 1. CONFIGURAÇÃO PASSPORT (AUTENTICAÇÃO) ---

// Serialização: Como guardar o utilizador na "memória" da sessão
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email FROM users WHERE id = ?", [id], (err, row) => done(err, row));
});

// Estratégia LOCAL (Email/Password)
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return done(err);
        if (!user || !user.password) return done(null, false, { message: 'Utilizador não encontrado.' });
        
        try {
            const match = await bcrypt.compare(password, user.password);
            if (!match) return done(null, false, { message: 'Password incorreta.' });
            return done(null, user);
        } catch (e) { return done(e); }
    });
}));

// Estratégia GOOGLE (Só ativa se as chaves existirem no .env)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback"
    }, (accessToken, refreshToken, profile, done) => {
        const email = profile.emails[0].value;
        const googleId = profile.id;
        const name = profile.displayName;

        // Verifica se o user já existe (pelo Google ID ou Email)
        db.get("SELECT * FROM users WHERE google_id = ? OR email = ?", [googleId, email], (err, user) => {
            if (err) return done(err);
            if (user) return done(null, user); // Utilizador já existe, faz login
            
            // Se não existe, cria novo utilizador
            db.run("INSERT INTO users (name, email, google_id) VALUES (?, ?, ?)", 
                [name, email, googleId], function(err) {
                if (err) return done(err);
                
                // Lógica de Legado: Se for o primeiro user (ID 1), herda a coleção antiga anónima
                if (this.lastID === 1) {
                    db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                }
                
                done(null, { id: this.lastID, name, email });
            });
        });
    }));
} else {
    console.log("⚠️ Aviso: Google Auth não configurado (Faltam chaves no .env). O login Google estará desativado.");
}

// --- 2. MIDDLEWARES DO EXPRESS ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Necessário para ler o formulário de login

// Configuração da Sessão (Cookies)
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }), // Cria ficheiro separado para sessões
    secret: process.env.SESSION_SECRET || 'segredo_padrao_muito_seguro',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // Sessão dura 30 dias
}));

app.use(passport.initialize());
app.use(passport.session());

// Middleware Global: Disponibiliza o utilizador para todas as Views
app.use((req, res, next) => {
    res.locals.user = req.user;
    next();
});

// --- 3. ROTAS PRINCIPAIS ---

// Rota da Homepage (Lógica de Filtragem Inteligente)
app.get('/', (req, res) => {
    const userId = req.user ? req.user.id : null;
    let { theme, year, search } = req.query;
    const currentYear = new Date().getFullYear();
    
    let viewMode = 'default'; 

    // Query Base: Junta dados dos Sets com Temas e verifica se o User logado tem o set
    let sql = `
        SELECT sets.*, themes.name as theme_name, 
        CASE WHEN user_sets.user_id IS NOT NULL THEN 1 ELSE 0 END as is_owned
        FROM sets 
        LEFT JOIN themes ON sets.theme_id = themes.id 
        LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? 
        WHERE 1=1
    `;
    let params = [userId];

    const hasFilters = theme || year || search;

    // Cenário 1: Visitante (Não logado)
    if (!userId) {
        if (!hasFilters) {
            // Se não filtrar nada, mostra só o ano atual (Performance)
            sql += " AND sets.year = ?";
            params.push(currentYear);
            viewMode = 'visitor_home';
        } else {
             viewMode = 'global_search';
        }
    } 
    // Cenário 2: Utilizador Logado
    else {
        if (!hasFilters) {
            // Se não filtrar nada, mostra A MINHA COLEÇÃO
            sql += " AND user_sets.user_id = ?";
            params.push(userId);
            viewMode = 'my_collection';
        } else {
            // Se filtrar, busca na base global mas mostra o que já tenho
            viewMode = 'global_search';
        }
    }

    // Aplica Filtros de Pesquisa
    if (theme) { sql += " AND themes.name LIKE ?"; params.push(`%${theme}%`); }
    if (year) { sql += " AND sets.year = ?"; params.push(year); }
    if (search) { sql += " AND (sets.name LIKE ? OR sets.set_num LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }

    // Ordenação e Limite
    sql += " ORDER BY sets.year DESC, sets.name ASC LIMIT 300";

    db.all(sql, params, (err, sets) => {
        if (err) console.error("Erro SQL:", err);
        
        // Busca listas para os Dropdowns
        db.all("SELECT DISTINCT name FROM themes ORDER BY name", [], (e1, themes) => {
            db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, years) => {
                res.render('index', { 
                    sets: sets || [], 
                    themes: themes || [], 
                    years: years || [], 
                    query: req.query, 
                    viewMode,
                    currentYear
                });
            });
        });
    });
});

// --- 4. ROTAS DE AUTENTICAÇÃO ---

app.get('/login', (req, res) => res.render('login'));

app.post('/login', passport.authenticate('local', { 
    successRedirect: '/', 
    failureRedirect: '/login?error=falha' 
}));

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

app.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", 
            [name, email, hashedPassword], 
            function(err) {
                if (err) return res.redirect('/login?err=exists');
                
                // Migração de Legado para o 1º User Registado
                if (this.lastID === 1) {
                   db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
                }
                res.redirect('/login?success=created');
            });
    } catch (e) { res.redirect('/login'); }
});

// --- 5. ROTAS GOOGLE (COM PROTEÇÃO) ---

app.get('/auth/google', (req, res, next) => {
    // CORREÇÃO AQUI: Verifica se a estratégia existe antes de chamar
    if (!GOOGLE_CLIENT_ID) {
        return res.send("<h1>Erro de Configuração</h1><p>O Login Google não está configurado no servidor (.env).</p><a href='/login'>Voltar</a>");
    }
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', 
    (req, res, next) => {
        if (!GOOGLE_CLIENT_ID) return res.redirect('/login');
        next();
    },
    passport.authenticate('google', { failureRedirect: '/login' }), 
    (req, res) => res.redirect('/')
);

// --- 6. API (ADICIONAR/REMOVER SETS) ---

app.post('/api/toggle', (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Não autorizado" });
    
    const { set_num, active } = req.body;
    const userId = req.user.id;

    if (active) {
        db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) VALUES (?, ?)", [userId, set_num], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, status: 'added' });
        });
    } else {
        db.run("DELETE FROM user_sets WHERE user_id = ? AND set_num = ?", [userId, set_num], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, status: 'removed' });
        });
    }
});

// --- 7. INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
