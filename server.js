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

// Configuração de Email
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER) { console.log(`\n📨 [EMAIL SIMULADO] Para: ${to}\n${text}\n`); return; }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

function ensureAdmin(req, res, next) { if (req.user && req.user.id === 1) return next(); res.status(403).send("Acesso Negado."); }

// --- CONFIGURAÇÃO PASSPORT (CORRIGIDA) ---
passport.serializeUser((user, done) => done(null, user.id));

// AQUI ESTAVA O ERRO: Agora tratamos o caso de utilizador não encontrado
passport.deserializeUser((id, done) => {
    db.get("SELECT id, name, email, dark_mode, items_per_page, google_id FROM users WHERE id = ?", [id], (err, row) => {
        if (err) return done(err);
        if (!row) return done(null, false); // Se não encontrar, faz logout em vez de erro
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
                if(this.lastID === 1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned = 1");
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

// Helper DB
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
        if (userId) {
            if (status === 'owned') { whereClause += " AND user_sets.user_id = ? AND user_sets.status = 'OWNED'"; params.push(userId); }
            else if (status === 'wanted') { whereClause += " AND user_sets.user_id = ? AND user_sets.status = 'WANTED'"; params.push(userId); }
            else if (!themes && !year && !search) { whereClause += " AND user_sets.user_id = ?"; params.push(userId); }
        }
    }
    return { whereClause, params };
}

// --- ROTAS DO SCANNER (V11.2 - COM APRENDIZAGEM) ---

app.get('/manual', (req, res) => res.render('manual', { user: req.user }));

// 1. ROTA DE PESQUISA (Agora verifica DB local primeiro)
app.get('/api/scan', async (req, res) => {
    if (!req.user) return res.status(401).send();
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Código inválido' });

    const cleanCode = code.trim();
    let foundSetNum = null;
    let debugLog = [];

    console.log(`\n🔍 [SCANNER] Recebido: "${cleanCode}"`);
    debugLog.push(`Recebido: ${cleanCode}`);

    try {
        // PASSO 0: VERIFICAR MEMÓRIA LOCAL
        const localMatch = await dbGet("SELECT set_num FROM barcodes WHERE code = ?", [cleanCode]);
        
        if (localMatch) {
            foundSetNum = localMatch.set_num;
            console.log(`   🧠 Memória Local: ${cleanCode} -> ${foundSetNum}`);
            debugLog.push(`Memória Local: Encontrado -> ${foundSetNum}`);
        } 
        else if (cleanCode.length < 8) {
            // Se for numero curto, é o set direto
            foundSetNum = cleanCode.includes('-') ? cleanCode : `${cleanCode}-1`;
            debugLog.push(`Assumido como Set ID`);
        } 
        else {
            // Tenta APIs Externas
            if (process.env.BRICKSET_API_KEY) {
                try {
                    const bsParams = JSON.stringify({ query: cleanCode });
                    const bsUrl = `https://brickset.com/api/v3.asmx/getSets?apiKey=${process.env.BRICKSET_API_KEY}&userHash=&params=${encodeURIComponent(bsParams)}`;
                    const bsRes = await axios.get(bsUrl, { timeout: 5000 });
                    if (bsRes.data && bsRes.data.sets && bsRes.data.sets.length > 0) {
                        const match = bsRes.data.sets[0];
                        foundSetNum = `${match.number}-${match.numberVariant}`;
                        debugLog.push(`Brickset: Sucesso -> ${foundSetNum}`);
                    }
                } catch (err) { debugLog.push(`Erro Brickset`); }
            }
            
            if (!foundSetNum) {
                const rbUrl = `https://rebrickable.com/api/v3/lego/sets/?search=${cleanCode}&page_size=1`;
                const rbRes = await axios.get(rbUrl, { headers: { 'Authorization': `key ${process.env.REBRICKABLE_API_KEY}` }});
                if (rbRes.data.results && rbRes.data.results.length > 0) {
                    foundSetNum = rbRes.data.results[0].set_num;
                    debugLog.push(`Rebrickable: Sucesso -> ${foundSetNum}`);
                }
            }
        }

        // BUSCAR DETALHES FINAIS
        if (foundSetNum) {
            const detailsUrl = `https://rebrickable.com/api/v3/lego/sets/${foundSetNum}/`;
            const detailsRes = await axios.get(detailsUrl, { headers: { 'Authorization': `key ${process.env.REBRICKABLE_API_KEY}` }});
            const set = detailsRes.data;

            const row = await dbGet("SELECT status FROM user_sets WHERE user_id = ? AND set_num = ?", [req.user.id, set.set_num]);
            
            res.json({
                found: true,
                debug: debugLog,
                set: {
                    set_num: set.set_num,
                    name: set.name,
                    year: set.year,
                    img_url: set.set_img_url,
                    num_parts: set.num_parts,
                    user_status: row ? row.status : null
                }
            });
        } else {
            console.log(`   ❌ Não encontrado em lado nenhum.`);
            res.json({ found: false, debug: debugLog, scanned_code: cleanCode });
        }

    } catch (e) {
        console.error(`💥 ERRO SCANNER: ${e.message}`);
        res.json({ found: false, debug: debugLog, error: e.message }); 
    }
});

// 2. NOVA ROTA: APRENDER ASSOCIAÇÃO
app.post('/api/scan/associate', (req, res) => {
    if (!req.user) return res.status(401).send();
    const { barcode, set_num } = req.body;

    if (!barcode || !set_num) return res.status(400).send();

    // Guardar na tabela barcodes
    db.run("INSERT OR REPLACE INTO barcodes (code, set_num) VALUES (?, ?)", [barcode, set_num], (err) => {
        if (err) {
            console.error("Erro ao associar barcode:", err.message);
            return res.status(500).json({success: false});
        }
        console.log(`💾 [APRENDIZAGEM] Associado: ${barcode} = ${set_num}`);
        res.json({success: true});
    });
});

// --- RESTO DAS ROTAS (IGUAIS) ---

app.get('/import', (req, res) => { if (!req.user) return res.redirect('/login'); res.render('import', { user: req.user }); });
app.get('/api/export', (req, res) => { if (!req.user) return res.status(401).send(); const sql = `SELECT user_sets.set_num, sets.name, user_sets.quantity, user_sets.status, user_sets.purchase_price, user_sets.build_status, user_sets.location FROM user_sets LEFT JOIN sets ON user_sets.set_num = sets.set_num WHERE user_sets.user_id = ?`; db.all(sql, [req.user.id], (err, rows) => { if (err) return res.status(500).send("Erro."); let csvContent = "set_num,name,quantity,status,purchase_price,build_status,location\n"; rows.forEach(row => { const name = row.name ? `"${row.name.replace(/"/g, '""')}"` : ""; const line = [row.set_num, name, row.quantity, row.status, row.purchase_price || 0, row.build_status || '', row.location || ''].join(","); csvContent += line + "\n"; }); res.header('Content-Type', 'text/csv'); res.header('Content-Disposition', 'attachment; filename="lego_collection.csv"'); res.send(csvContent); }); });
app.post('/api/import', upload.single('csvfile'), (req, res) => { if (!req.user) return res.status(401).send(); if (!req.file) return res.redirect('/import?error=Ficheiro em falta'); const results = []; fs.createReadStream(req.file.path).pipe(csv()).on('data', (data) => results.push(data)).on('end', () => { fs.unlinkSync(req.file.path); let successCount = 0; const stmt = db.prepare(`INSERT INTO user_sets (user_id, set_num, quantity, status, purchase_price, build_status, location) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, set_num) DO UPDATE SET quantity = excluded.quantity, status = excluded.status, purchase_price = excluded.purchase_price, build_status = excluded.build_status, location = excluded.location`); db.serialize(() => { db.run("BEGIN TRANSACTION"); results.forEach(row => { let setNum = row.set_num || row['Set Number'] || row['SetNumber']; if (setNum) { if (!setNum.includes('-')) setNum += '-1'; const qty = parseInt(row.quantity || 1) || 1; let status = 'OWNED'; if ((row.status || '').toUpperCase().includes('WANT')) status = 'WANTED'; const price = parseFloat(row.purchase_price || 0) || 0; const build = row.build_status || 'Montado'; const loc = row.location || ''; stmt.run(req.user.id, setNum, qty, status, price, build, loc); successCount++; } }); stmt.finalize(); db.run("COMMIT", () => { res.redirect(`/import?success=${successCount} importados!`); }); }); }); });
app.get('/dashboard', (req, res) => { if (!req.user) return res.redirect('/login'); const userId = req.user.id; const q1 = new Promise(r => db.get(`SELECT COUNT(*) as total_sets, SUM(quantity) as total_items, SUM(sets.num_parts * user_sets.quantity) as total_parts, COALESCE(SUM(user_sets.purchase_price * user_sets.quantity), 0) as total_spent, COALESCE(SUM(sets.price_eur * user_sets.quantity), 0) as total_value_rrp FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'OWNED'`, [userId], (e, row) => r(row))); const q2 = new Promise(r => db.get(`SELECT COUNT(*) as wanted_count, COALESCE(SUM(sets.price_eur), 0) as wanted_value FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_id = ? AND status = 'WANTED'`, [userId], (e, row) => r(row))); const q3 = new Promise(r => db.all(`SELECT themes.name, COUNT(*) as count FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num JOIN themes ON sets.theme_id = themes.id WHERE user_sets.user_id = ? AND user_sets.status = 'OWNED' GROUP BY themes.name ORDER BY count DESC LIMIT 5`, [userId], (e, rows) => r(rows))); const q4 = new Promise(r => db.all(`SELECT sets.year, COUNT(*) as count FROM user_sets JOIN sets ON user_sets.set_num = sets.set_num WHERE user_sets.user_id = ? AND user_sets.status = 'OWNED' GROUP BY sets.year ORDER BY sets.year ASC`, [userId], (e, rows) => r(rows))); Promise.all([q1, q2, q3, q4]).then(([stats, wishlist, themes, years]) => { res.render('dashboard', { stats: stats || {}, wishlist: wishlist || {}, themes: themes || [], years: years || [], user: req.user }); }).catch(e => res.send("Erro: " + e.message)); });
app.get('/', (req, res) => { const userId = req.user ? req.user.id : null; let { limit, page, sort } = req.query; let limitVal = limit || (req.user ? req.user.items_per_page : 25); if (limitVal === 'all') limitVal = 10000; let pageVal = parseInt(page) || 1; let offset = (pageVal - 1) * limitVal; const filter = buildFilters(req.query, userId, false); let orderBy = "themes.name ASC, sets.year DESC"; if (sort === 'year_desc') orderBy = "sets.year DESC, sets.name ASC"; if (sort === 'year_asc') orderBy = "sets.year ASC, sets.name ASC"; if (sort === 'parts_desc') orderBy = "sets.num_parts DESC"; if (sort === 'added_desc') orderBy = "user_sets.date_added DESC"; if (sort === 'name_asc') orderBy = "sets.name ASC"; let countSql = `SELECT COUNT(*) as total FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${filter.whereClause}`; db.get(countSql, [userId, ...filter.params], (err, row) => { const totalItems = row ? row.total : 0; const totalPages = Math.ceil(totalItems / limitVal); let dataSql = `SELECT sets.*, themes.name as theme_name, user_sets.status as user_status, user_sets.quantity FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? ${filter.whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`; db.all(dataSql, [userId, ...filter.params, limitVal, offset], (err, sets) => { let themesSql = `SELECT themes.name, MIN(sets.year) as min_year, MAX(sets.year) as max_year FROM themes JOIN sets ON themes.id = sets.theme_id WHERE (themes.is_hidden IS NULL OR themes.is_hidden = 0) GROUP BY themes.name ORDER BY themes.name ASC`; db.all(themesSql, [], (e1, allThemes) => { db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => { res.render('index', { sets: sets || [], allThemes: allThemes || [], allYears: allYears || [], query: req.query, pagination: { page: pageVal, limit: limitVal, totalPages, totalItems }, user: req.user, currentYear: new Date().getFullYear() }); }); }); }); }); });
app.get('/set/:set_num', (req, res) => { const userId = req.user ? req.user.id : null; const { set_num } = req.params; const sql = `SELECT sets.*, themes.name as theme_name, user_sets.status as user_status, user_sets.quantity, user_sets.date_added, user_sets.build_status, user_sets.location, user_sets.purchase_price, sets.price_eur FROM sets LEFT JOIN themes ON sets.theme_id = themes.id LEFT JOIN user_sets ON sets.set_num = user_sets.set_num AND user_sets.user_id = ? WHERE sets.set_num = ?`; db.get(sql, [userId, set_num], (err, set) => { if (err || !set) return res.status(404).render('index', { error: 'Set não encontrado', sets:[], allThemes:[], allYears:[], query:{}, pagination:{}, user: req.user }); set.rb_url = `https://rebrickable.com/sets/${set.set_num}`; res.render('set_detail', { set, user: req.user }); }); });
app.post('/api/toggle', (req, res) => { if (!req.user) return res.status(401).send(); const { set_num, status } = req.body; if (status === 'REMOVE') db.run("DELETE FROM user_sets WHERE user_id=? AND set_num=?", [req.user.id, set_num], () => res.json({ok: true, status: null})); else { const sql = `INSERT INTO user_sets (user_id, set_num, status, quantity, build_status) VALUES (?, ?, ?, 1, 'Montado') ON CONFLICT(user_id, set_num) DO UPDATE SET status = excluded.status`; db.run(sql, [req.user.id, set_num, status], () => res.json({ok: true, status: status})); } });
app.post('/api/user_set/update', (req, res) => { if (!req.user) return res.status(401).send(); const { set_num, build_status, location, purchase_price, price_eur } = req.body; db.run("UPDATE user_sets SET build_status = ?, location = ?, purchase_price = ? WHERE user_id = ? AND set_num = ?", [build_status, location, purchase_price || 0, req.user.id, set_num], (err) => { if (err) return res.status(500).json({error: err.message}); if (price_eur !== undefined) db.run("UPDATE sets SET price_eur = ? WHERE set_num = ?", [price_eur || 0, set_num], () => res.json({success: true})); else res.json({success: true}); }); });
app.post('/api/preferences', (req, res) => { if (!req.user) return res.status(401).send(); const { dark_mode, items_per_page } = req.body; let sql="UPDATE users SET ", p=[], u=[]; if(dark_mode!==undefined) {u.push("dark_mode=?"); p.push(dark_mode?1:0);} if(items_per_page!==undefined) {u.push("items_per_page=?"); p.push(items_per_page);} if(u.length) { sql+=u.join(",")+" WHERE id=?"; p.push(req.user.id); db.run(sql,p,()=>res.json({ok:true})); } else res.json({ok:true}); });

// ADMIN (IGUAIS)
app.get('/admin/sets', ensureAdmin, (req, res) => { let { limit, page } = req.query; let limitVal = limit || 50; let pageVal = parseInt(page) || 1; let offset = (pageVal - 1) * limitVal; const filter = buildFilters(req.query, req.user.id, true); let countSql = `SELECT COUNT(*) as total FROM sets LEFT JOIN themes ON sets.theme_id = themes.id ${filter.whereClause}`; db.get(countSql, filter.params, (err, row) => { const totalItems = row ? row.total : 0; const totalPages = Math.ceil(totalItems / limitVal); let dataSql = `SELECT sets.*, themes.name as theme_name FROM sets LEFT JOIN themes ON sets.theme_id = themes.id ${filter.whereClause} ORDER BY sets.year DESC, sets.name ASC LIMIT ? OFFSET ?`; db.all(dataSql, [...filter.params, limitVal, offset], (err, sets) => { let themesSql = `SELECT themes.name, MIN(sets.year) as min_year, MAX(sets.year) as max_year FROM themes JOIN sets ON themes.id = sets.theme_id GROUP BY themes.name ORDER BY themes.name ASC`; db.all(themesSql, [], (e1, allThemes) => { db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (e2, allYears) => { res.render('admin/sets', { sets: sets || [], allThemes: allThemes || [], allYears: allYears || [], query: req.query, pagination: { page: pageVal, limit: limitVal, totalPages, totalItems }, user: req.user }); }); }); }); }); });
app.post('/admin/sets/toggle', ensureAdmin, (req, res) => { const { set_num, field, value } = req.body; if (!['is_hidden', 'ignore_parts'].includes(field)) return res.status(400).send(); db.run(`UPDATE sets SET ${field} = ? WHERE set_num = ?`, [value ? 1 : 0, set_num], (err) => res.json({success: !err})); });
app.get('/admin/themes', ensureAdmin, (req, res) => { const sql = `SELECT t.id, t.name, t.is_hidden, t.ignore_parts, COUNT(s.set_num) as total_sets, SUM(CASE WHEN s.num_parts = 0 THEN 1 ELSE 0 END) as zero_part_sets, MIN(s.year) as min_year, MAX(s.year) as max_year FROM themes t LEFT JOIN sets s ON t.id = s.theme_id GROUP BY t.id ORDER BY t.name ASC`; db.all(sql, [], (err, themes) => res.render('admin/themes', { themes: themes || [], user: req.user })); });
app.post('/admin/themes/toggle', ensureAdmin, (req, res) => { const { theme_id, field, value } = req.body; if (!['is_hidden', 'ignore_parts'].includes(field)) return res.status(400).send(); db.run(`UPDATE themes SET ${field} = ? WHERE id = ?`, [value ? 1 : 0, theme_id], (err) => res.json({success: !err})); });
app.get('/admin/users', ensureAdmin, (req, res) => { let { sort } = req.query; let orderBy = "id ASC"; if (sort === 'name') orderBy = "name ASC"; else if (sort === 'login') orderBy = "google_id DESC"; else if (sort === 'access') orderBy = "last_login DESC"; db.all(`SELECT id, name, email, google_id, is_verified, last_login FROM users ORDER BY ${orderBy}`, [], (err, users) => res.render('admin/users', { users: users || [], sort, user: req.user })); });
app.post('/admin/users/reset', ensureAdmin, async (req, res) => { const { user_id, type } = req.body; db.get("SELECT * FROM users WHERE id = ?", [user_id], (err, user) => { if (!user || user.google_id) return res.json({error: "Utilizador Google ou inválido."}); const token = crypto.randomBytes(32).toString('hex'); db.run("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?", [token, Date.now() + 3600000, user_id], async () => { const link = `http://${req.headers.host}/reset/${token}`; if (type === 'email') { await sendEmail(user.email, "Reset Admin", `Link: ${link}`); res.json({success: true, message: "Enviado."}); } else res.json({success: true, link}); }); }); });
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res, next) => { passport.authenticate('local', (err, user, info) => { if (err) return next(err); if (!user) return res.redirect('/login?error=' + encodeURIComponent(info.message || 'Erro')); req.logIn(user, (err) => { if(err) return next(err); res.redirect('/'); }); })(req, res, next); });
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));
app.get('/auth/google', (req, res, next) => { if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send("Google ID em falta."); passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next); });
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login?error=Falha Google' }), (req, res) => res.redirect('/'));
app.post('/register', async (req, res) => { const { name, email, password } = req.body; try { const exists = await new Promise(r => db.get("SELECT id FROM users WHERE email=?", [email], (e,row)=>r(row))); if(exists) return res.redirect('/login?error=Email já existe'); const hashed = await bcrypt.hash(password, 10); const token = crypto.randomBytes(32).toString('hex'); db.run("INSERT INTO users (name,email,password,is_verified,verify_token,last_login) VALUES (?,?,?,0,?,NULL)", [name,email,hashed,token], function(err){ if(err) return res.redirect('/login?error=Erro registo'); sendEmail(email, "Ativar Conta", `Link: http://${req.headers.host}/verify/${token}`); if(this.lastID===1) db.run("INSERT OR IGNORE INTO user_sets (user_id, set_num) SELECT 1, set_num FROM sets WHERE owned=1"); res.redirect('/login?success=Verifique Email'); }); } catch(e) { res.redirect('/login?error=Erro servidor'); } });
app.get('/verify/:token', (req, res) => { db.get("SELECT id FROM users WHERE verify_token=?", [req.params.token], (e,u) => { if(!u) return res.redirect('/login?error=Token inválido'); db.run("UPDATE users SET is_verified=1, verify_token=NULL WHERE id=?", [u.id], ()=> res.redirect('/login?success=Ativado!')); }); });
cron.schedule('0 4 * * *', () => exec('node sync.js', (e, out) => console.log(out || e)));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
