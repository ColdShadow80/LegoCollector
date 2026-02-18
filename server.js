require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const util = require('util');
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

// Simple in-memory cache for frequently accessed data
const cache = {
    years: null,
    yearsExpiry: 0,
    getYears() {
        const now = Date.now();
        if (this.years && this.yearsExpiry > now) {
            return Promise.resolve(this.years);
        }
        // Get years and cache for 5 minutes
        return new Promise((resolve, reject) => {
            db.all("SELECT DISTINCT year FROM sets ORDER BY year DESC", [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    this.years = rows || [];
                    this.yearsExpiry = now + 5 * 60 * 1000; // 5 minute cache
                    resolve(this.years);
                }
            });
        });
    },
    clearYears() {
        this.years = null;
        this.yearsExpiry = 0;
    }
};

// Configuração do EJS e Pasta Pública
app.set('view engine', 'ejs');
app.use(express.static('public', { 
    maxAge: '1d',  // Cache static files for 1 day
    etag: false    // Disable ETag for better cache performance
}));
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

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        passport.use(new GoogleStrategy({
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback"
            },
      (accessToken, refreshToken, profile, done) => {
        try {
          console.log('GoogleStrategy: profile received', profile && profile.id);
          const emails = profile && profile.emails ? profile.emails.map(e => e.value) : [];
          console.log('GoogleStrategy: emails', emails);
          const email = emails.length > 0 ? emails[0] : null;
          if (!email) return done(new Error('No email available in Google profile'));

          db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
              if (err) {
                  console.error('DB error looking up user by email', err);
                  return done(err);
              }
              if (user) {
                  if (!user.google_id) {
                      db.run("UPDATE users SET google_id = ? WHERE id = ?", [profile.id, user.id], function(upErr) {
                          if (upErr) console.error('Failed to update google_id', upErr);
                      });
                  }
                  return done(null, user);
              } else {
                  db.run("INSERT INTO users (name, email, google_id, is_verified) VALUES (?, ?, ?, 1)",
                      [profile.displayName || null, email, profile.id],
                      function(insErr) {
                          if (insErr) {
                              console.error('Failed to insert Google user', insErr);
                              return done(insErr);
                          }
                          db.get("SELECT * FROM users WHERE id = ?", [this.lastID], (e, u) => {
                              if (e) console.error('Failed to fetch newly inserted user', e);
                              return done(e, u);
                          });
                      }
                  );
              }
          });
        } catch (ex) {
          console.error('Exception in GoogleStrategy callback', ex);
          return done(ex);
        }
      }
    ));
} else {
    console.log('Google OAuth not configured (GOOGLE_CLIENT_ID/SECRET missing) — skipping Google auth setup.');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, user) => done(err, user));
});

function ensureAdmin(req, res, next) {
    if (req.user && req.user.id === 1) return next();
    res.status(403).send("Acesso Negado.");
}

// --- ROTAS PRINCIPAIS ---

// Cache headers middleware for homepage (5 minute cache)
const setCacheHeaders = (req, res, next) => {
    res.set('Cache-Control', 'private, max-age=300'); // 5 minute cache
    next();
};

// 1. HOMEPAGE (Com a correção dos filtros)
app.get('/', setCacheHeaders, (req, res) => {
    const filterSearch = req.query.q || '';
    const filterThemes = req.query.themes || '';
    const filterYear = req.query.year || '';
    const filterSort = req.query.sort || 'newest';
    const filterStatus = req.query.status || '';
    const page = parseInt(req.query.page) || 1;
    
    // Log incoming filters for debugging
    console.log('\n📋 Homepage request with filters:');
    console.log('  q:', filterSearch);
    console.log('  themes:', filterThemes);
    console.log('  year:', filterYear);
    console.log('  status:', filterStatus);
    console.log('  page:', page);
    
    // Paginação: se houver limit na query string (do select dropdown), use-o
    // Senão, use a preferência do utilizador, ou default 24
    let limit = 24;
    if (req.query.limit) {
        const paramLimit = req.query.limit;
        if (paramLimit === 'all') {
            limit = 999999; // arbitrariamente grande
        } else {
            const parsed = parseInt(paramLimit);
            if ([25, 50, 100].includes(parsed)) {
                limit = parsed;
            }
        }
        console.log('  limit (from query):', limit);
    } else if (req.user && req.user.items_per_page) {
        const userPref = req.user.items_per_page;
        if (userPref === 'all') {
            limit = 999999;
        } else {
            const parsed = parseInt(userPref);
            if ([25, 50, 100].includes(parsed)) {
                limit = parsed;
            } else {
                limit = 24; // default if invalid value
            }
        }
        console.log('  limit (from user pref):', limit);
    }
    
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
    if (filterThemes) {
        if (Array.isArray(filterThemes)) {
            const placeholders = filterThemes.map(() => '?').join(',');
            sql += ` AND s.theme_id IN (${placeholders})`;
            params.push(...filterThemes.map(t => parseInt(t)));
        } else {
            sql += " AND s.theme_id = ?";
            params.push(parseInt(filterThemes));
        }
    }
    if (filterYear) {
        sql += " AND s.year = ?";
        params.push(filterYear);
    }

    // Filter by user's status (OWNED / WANTED)
    if (filterStatus === 'owned') {
        sql += " AND us.status = 'OWNED'";
    } else if (filterStatus === 'wanted') {
        sql += " AND us.status = 'WANTED'";
    }

    // Ordenação
    if (filterSort === 'pieces') sql += " ORDER BY s.num_parts DESC";
    else if (filterSort === 'price') sql += " ORDER BY s.price_eur DESC";
    else sql += " ORDER BY s.year DESC, s.set_num DESC"; 

    // Executar Queries
    // OPTIMIZED: Use single GROUP BY query instead of subqueries (major performance improvement)
    db.all(`
        SELECT t.id, t.name,
               COUNT(s.set_num) as count,
               MIN(s.year) as min_year,
               MAX(s.year) as max_year
        FROM themes t
        LEFT JOIN sets s ON s.theme_id = t.id
        GROUP BY t.id, t.name
        ORDER BY t.name
    `, [], (err, themes) => {
        if(err) {
            console.error('\u274c Themes query error:');
            console.error('Error:', err);
            return res.status(500).send("Erro Temas");
        }

        // Contagem Total
        let countSql = `SELECT COUNT(*) as total FROM sets s WHERE 1=1`;
        let countParams = [];
        if (filterSearch) { countSql += " AND (s.name LIKE ? OR s.set_num LIKE ?)"; countParams.push(`%${filterSearch}%`, `%${filterSearch}%`); }
        if (filterThemes) {
            if (Array.isArray(filterThemes)) {
                const placeholders = filterThemes.map(() => '?').join(',');
                countSql += ` AND s.theme_id IN (${placeholders})`;
                countParams.push(...filterThemes.map(t => parseInt(t)));
            } else {
                countSql += " AND s.theme_id = ?"; countParams.push(parseInt(filterThemes));
            }
        }
        if (filterYear) { countSql += " AND s.year = ?"; countParams.push(filterYear); }
        if (filterStatus === 'owned') { countSql += " AND EXISTS (SELECT 1 FROM user_sets us2 WHERE us2.set_num = s.set_num AND us2.user_id = ? AND us2.status = 'OWNED')"; countParams.push(req.user ? req.user.id : 0); }
        else if (filterStatus === 'wanted') { countSql += " AND EXISTS (SELECT 1 FROM user_sets us2 WHERE us2.set_num = s.set_num AND us2.user_id = ? AND us2.status = 'WANTED')"; countParams.push(req.user ? req.user.id : 0); }

        db.get(countSql, countParams, (e, countRow) => {
            if (e) {
                console.error('\u274c Count query error:');
                console.error('SQL:', countSql);
                console.error('Params:', countParams);
                console.error('Error:', e);
            }
            const totalSets = countRow ? countRow.total : 0;
            const totalPages = Math.ceil(totalSets / limit);

            sql += " LIMIT ? OFFSET ?";
            params.push(limit, offset);
            
            console.log('📊 Final query:');
            console.log('  Total sets:', totalSets);
            console.log('  Total pages:', totalPages);

            db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('❌ Homepage filter query error:');
                    console.error('SQL:', sql);
                    console.error('Params:', params);
                    console.error('Error:', err);
                    return res.status(500).send("Erro BD");
                }

                // Preserve DB fields expected by the original template
                const processedSets = rows.map(s => ({
                    ...s,
                    user_status: s.user_status || null
                }));
                
                console.log('✅ Homepage query successful. Returned', rows.length, 'sets');

                // Get available years for the left menu (cached for 5 minutes)
                cache.getYears().then(allYears => {
                    res.render('index', {
                        sets: processedSets,
                        themes: themes,
                        allThemes: themes,
                        allYears: allYears || [],
                        query: {
                            search: filterSearch,
                            theme: filterThemes,
                            year: filterYear,
                            sort: filterSort,
                            status: req.query.status || '',
                            themes: req.query.themes || ''
                        },
                        pagination: { page, totalPages, limit, totalItems: totalSets },
                        filters: { // keep compatibility with newer code
                            search: filterSearch,
                            theme: filterThemes,
                            year: filterYear,
                            sort: filterSort
                        }
                    });
                }).catch(err => {
                    console.error('✗ Years cache error:', err);
                    res.render('index', {
                        sets: processedSets,
                        themes: themes,
                        allThemes: themes,
                        allYears: [],
                        query: {
                            search: filterSearch,
                            theme: filterThemes,
                            year: filterYear,
                            sort: filterSort,
                            status: req.query.status || '',
                            themes: req.query.themes || ''
                        },
                        pagination: { page, totalPages, limit, totalItems: totalSets },
                        filters: {
                            search: filterSearch,
                            theme: filterThemes,
                            year: filterYear,
                            sort: filterSort
                        }
                    });
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

// --- BARCODE LOOKUP / TEACH ENDPOINTS ---
// Lookup barcode mapping
app.get('/api/barcode/:code', (req, res) => {
    const code = req.params.code;
    db.get("SELECT set_num FROM barcodes WHERE code = ?", [code], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ found: false });
        res.json({ found: true, set_num: row.set_num });
    });
});

// Teach mapping (requires logged-in user)
app.post('/api/barcode/teach', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    const { code, set_num } = req.body;
    if (!code || !set_num) return res.status(400).json({ error: 'missing_parameters' });

    db.run("INSERT OR REPLACE INTO barcodes (code, set_num) VALUES (?, ?)", [code, set_num], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
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
    const { user_id, type } = req.body;
    // generate reset token and save on user
    const token = crypto.randomBytes(20).toString('hex');
    const expires = Date.now() + (60 * 60 * 1000); // 1 hour
    db.get("SELECT email FROM users WHERE id = ?", [user_id], (e, u) => {
        if (e || !u) return res.status(400).json({ error: 'not_found' });
        db.run("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?", [token, expires, user_id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const link = `http://${req.headers.host}/reset/${token}`;
            if (type === 'email') {
                sendEmail(u.email, 'Reset Password', `Use this link to reset your password: ${link}`);
                return res.json({ success: true });
            }
            return res.json({ success: true, link });
        });
    });
});

// Create new user (admin only)
app.post('/admin/users/create', ensureAdmin, express.json(), (req, res) => {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, email e palavra-passe são obrigatórios.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'A palavra-passe deve ter pelo menos 6 caracteres.' });
    }

    // Check if email already exists
    db.get("SELECT id FROM users WHERE email = ?", [email], (err, existingUser) => {
        if (err) {
            return res.status(500).json({ error: 'Erro ao verificar email.' });
        }

        if (existingUser) {
            return res.status(400).json({ error: 'Este email já está registado.' });
        }

        // Hash password and create user
        bcrypt.hash(password, 10, (hashErr, hashedPassword) => {
            if (hashErr) {
                return res.status(500).json({ error: 'Erro ao processar palavra-passe.' });
            }

            db.run(
                "INSERT INTO users (name, email, password, is_verified) VALUES (?, ?, ?, 1)",
                [name, email, hashedPassword],
                function(insertErr) {
                    if (insertErr) {
                        return res.status(500).json({ error: 'Erro ao criar utilizador.' });
                    }

                    res.json({
                        success: true,
                        message: 'Utilizador criado com sucesso.',
                        user_id: this.lastID
                    });
                }
            );
        });
    });
});

// Forgot password (public)
app.get('/forgot', (req, res) => res.render('forgot'));
app.post('/forgot', (req, res) => {
    const { email } = req.body;
    if (!email) return res.render('forgot', { error: 'Email obrigatório' });
    db.get("SELECT id, email FROM users WHERE email = ?", [email], (err, user) => {
        if (err) return res.render('forgot', { error: 'Erro servidor' });
        if (!user) return res.render('forgot', { error: 'Conta não encontrada' });
        const token = crypto.randomBytes(20).toString('hex');
        const expires = Date.now() + (60 * 60 * 1000);
        db.run("UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?", [token, expires, user.id], function(eu) {
            if (eu) return res.render('forgot', { error: 'Erro servidor' });
            const link = `http://${req.headers.host}/reset/${token}`;
            sendEmail(user.email, 'Reset Password', `Clique para redefinir a password: ${link}`);
            return res.redirect('/login?success=reset_sent');
        });
    });
});

// Render reset form
app.get('/reset/:token', (req, res) => {
    const token = req.params.token;
    db.get("SELECT id, reset_expires FROM users WHERE reset_token = ?", [token], (err, u) => {
        if (err || !u) return res.redirect('/login?error=Token inválido');
        if (!u.reset_expires || u.reset_expires < Date.now()) return res.redirect('/login?error=Token expirado');
        res.render('reset', { token });
    });
});

// Apply new password
app.post('/reset/:token', async (req, res) => {
    const token = req.params.token;
    const password = req.body.password;
    if (!password) return res.redirect('/login?error=missing_password');
    db.get("SELECT id, reset_expires FROM users WHERE reset_token = ?", [token], async (err, u) => {
        if (err || !u) return res.redirect('/login?error=Token inválido');
        if (!u.reset_expires || u.reset_expires < Date.now()) return res.redirect('/login?error=Token expirado');
        try {
            const hashed = await bcrypt.hash(password, 10);
            db.run("UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?", [hashed, u.id], function(er) {
                if (er) return res.redirect('/login?error=Erro');
                return res.redirect('/login?success=PasswordAlterada');
            });
        } catch(e) { return res.redirect('/login?error=Erro'); }
    });
});

app.get('/admin/sets', ensureAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    if (req.query.export === 'csv') {
        // Export CSV
        db.all("SELECT * FROM sets", [], (err, rows) => {
            if (err) return res.status(500).send('Erro');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="sets.csv"');
            const header = ['set_num','name','year','num_parts','price_eur'].join(',') + '\n';
            const body = rows.map(r => `${r.set_num},"${(r.name||'').replace(/"/g,'""')}",${r.year||''},${r.num_parts||''},${r.price_eur||''}`).join('\n');
            res.send(header + body);
        });
        return;
    }

    // Add theme name and sorting
    const sortMap = {
        set_num: 's.set_num',
        name: 's.name',
        year: 's.year',
        num_parts: 's.num_parts',
        price_eur: 's.price_eur',
        theme_name: 't.name'
    };
    let sort = req.query.sort || 'set_num';
    let sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    if (!sortMap[sort]) sort = 'set_num';
    const orderBy = `${sortMap[sort]} ${sortDir}`;
    db.all("SELECT id, name FROM themes ORDER BY name", [], (err, allThemes) => {
        db.all(`SELECT s.*, t.name as theme_name FROM sets s LEFT JOIN themes t ON s.theme_id = t.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [limit, offset], (err2, rows) => {
            db.get("SELECT COUNT(*) as count FROM sets", (e, c) => {
                res.render('admin/sets', { sets: rows, pagination: { page, totalPages: Math.ceil(c.count/limit) }, sort, sortDir, allThemes });
            });
        });
    });
});

// Update set endpoint
app.post('/admin/sets/update', ensureAdmin, express.json(), (req, res) => {
    const { set_num, name, year, price_eur, is_hidden, ignore_parts } = req.body;
    if (!set_num) return res.status(400).json({ error: 'missing' });
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (year !== undefined) { updates.push('year = ?'); params.push(year); }
    if (price_eur !== undefined) { updates.push('price_eur = ?'); params.push(price_eur); }
    if (is_hidden !== undefined) { updates.push('is_hidden = ?'); params.push(is_hidden ? 1 : 0); }
    if (ignore_parts !== undefined) { updates.push('ignore_parts = ?'); params.push(ignore_parts ? 1 : 0); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(set_num);
    db.run(`UPDATE sets SET ${updates.join(', ')} WHERE set_num = ?`, params, function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); });
});

// Admin Barcodes Management Page
app.get('/admin/barcodes', ensureAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const filterTheme = req.query.theme || '';
    const filterSet = req.query.set || '';
    const filterBarcode = req.query.barcode || '';
    const sortBy = req.query.sort || 'barcode_asc';
    
    // Build WHERE clause
    let whereClauses = [];
    let params = [];
    if (filterTheme) {
        whereClauses.push('t.id = ?');
        params.push(parseInt(filterTheme));
    }
    if (filterSet) {
        whereClauses.push("s.set_num LIKE ?");
        params.push(`%${filterSet}%`);
    }
    if (filterBarcode) {
        whereClauses.push("b.code LIKE ?");
        params.push(`%${filterBarcode}%`);
    }
    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    
    // Build ORDER BY clause
    let orderClause = 'ORDER BY b.code ASC';
    if (sortBy === 'barcode_asc') orderClause = 'ORDER BY b.code ASC';
    else if (sortBy === 'barcode_desc') orderClause = 'ORDER BY b.code DESC';
    else if (sortBy === 'theme_asc') orderClause = 'ORDER BY t.name ASC, s.set_num ASC';
    else if (sortBy === 'theme_desc') orderClause = 'ORDER BY t.name DESC, s.set_num ASC';
    else if (sortBy === 'set_asc') orderClause = 'ORDER BY s.set_num ASC';
    else if (sortBy === 'set_desc') orderClause = 'ORDER BY s.set_num DESC';
    
    // Count total barcodes
    const countSql = `SELECT COUNT(*) as total FROM barcodes b 
                      LEFT JOIN sets s ON b.set_num = s.set_num 
                      LEFT JOIN themes t ON s.theme_id = t.id ${whereClause}`;
    db.get(countSql, params, (err, countRow) => {
        if (err) {
            console.error('Error counting barcodes:', err);
            return res.status(500).send('Erro ao contar códigos de barras');
        }
        
        const totalBarcodes = countRow ? countRow.total : 0;
        const totalPages = Math.ceil(totalBarcodes / limit);
        
        // Get paginated barcodes
        const sql = `SELECT b.code, b.set_num, s.name as set_name, s.theme_id, s.year, s.num_parts, t.id as theme_id, t.name as theme_name
                     FROM barcodes b 
                     LEFT JOIN sets s ON b.set_num = s.set_num 
                     LEFT JOIN themes t ON s.theme_id = t.id 
                     ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
        
        const queryParams = [...params, limit, offset];
        db.all(sql, queryParams, (err, barcodes) => {
            if (err) {
                console.error('Error fetching barcodes:', err);
                return res.status(500).send('Erro ao carregar códigos de barras');
            }
            
            // Get all themes for filter dropdown
            db.all("SELECT id, name FROM themes ORDER BY name", [], (err, themes) => {
                if (err) themes = [];
                
                res.render('admin/barcodes', {
                    barcodes: barcodes,
                    themes: themes,
                    pagination: { page, totalPages, limit, totalBarcodes },
                    filters: { theme: filterTheme, set: filterSet, barcode: filterBarcode, sort: sortBy }
                });
            });
        });
    });
});

// Delete barcode entry
app.post('/admin/barcodes/delete', ensureAdmin, express.json(), (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'missing_code' });
    
    db.run("DELETE FROM barcodes WHERE code = ?", [code], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/admin/themes', ensureAdmin, (req, res) => {
    // Sorting
    const allowedSort = ['id','name','total_sets','total_pieces','min_year','max_year'];
    let sort = req.query.sort || 'name';
    let sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    if (!allowedSort.includes(sort)) sort = 'name';
    const orderBy = `${sort} ${sortDir}`;

    // Query all themes with set/part stats and update status
    db.all(`
        SELECT t.*,
          (SELECT COUNT(*) FROM sets WHERE theme_id = t.id) as total_sets,
          (SELECT IFNULL(SUM(num_parts),0) FROM sets WHERE theme_id = t.id) as total_pieces,
          (SELECT MIN(year) FROM sets WHERE theme_id = t.id) as min_year,
          (SELECT MAX(year) FROM sets WHERE theme_id = t.id) as max_year
        FROM themes t
        ORDER BY ${orderBy}
    `, [], async (err, themes) => {
        if (err) return res.status(500).send('Erro Temas');
        // For each theme, get ignore_parts status for all sets
        for (const t of themes) {
            const sets = await new Promise((resolve) => db.all("SELECT ignore_parts FROM sets WHERE theme_id = ?", [t.id], (e, s) => resolve(s||[])));
            t.ignore_parts_count = sets.filter(s => s.ignore_parts).length;
            t.update_status = 'none';
            if (sets.length === 0) t.update_status = 'none';
            else if (t.ignore_parts_count === sets.length) t.update_status = 'all';
            else if (t.ignore_parts_count === 0) t.update_status = 'none';
            else t.update_status = 'partial';
            t.sets_count = sets.length;
        }
        res.render('admin/themes', { themes, sort, sortDir });
    });
});

// Create a new theme
app.post('/admin/themes/create', ensureAdmin, express.json(), (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'missing_id_or_name' });
    db.get("SELECT 1 FROM themes WHERE id = ?", [id], (err, exists) => {
        if (err) return res.status(500).json({ error: err.message });
        if (exists) return res.status(400).json({ error: 'id_exists' });
        db.run("INSERT INTO themes (id, name) VALUES (?, ?)", [id, name], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            db.get("SELECT * FROM themes WHERE id = ?", [id], (e, row) => res.json({ success: true, theme: row }));
        });
    });
});

// Update theme (name or is_hidden)
app.post('/admin/themes/update', ensureAdmin, express.json(), (req, res) => {
    const { id, name, is_hidden } = req.body;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (is_hidden !== undefined) { updates.push('is_hidden = ?'); params.push(is_hidden ? 1 : 0); }
    if (updates.length === 0) return res.json({ success: true });
    const sql = `UPDATE themes SET ${updates.join(', ')} WHERE id = ?`;
    params.push(id);
    db.run(sql, params, function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); });
});

// Toggle theme fields (is_hidden, etc.)
// Toggle theme fields (is_hidden, etc.) and bulk update ignore_parts for all sets in theme
app.post('/admin/themes/toggle', ensureAdmin, express.json(), (req, res) => {
    const { theme_id, field, value, update_sets } = req.body;
    if (!theme_id || !field) return res.status(400).json({ error: 'missing' });
    const val = (value === true || value === 'true' || value === 1 || value === '1') ? 1 : 0;
    const allowed = ['is_hidden','ignore_parts'];
    if (!allowed.includes(field)) return res.status(400).json({ error: 'invalid_field' });
    // If update_sets is true and field is ignore_parts, update all sets in theme
    if (field === 'ignore_parts' && update_sets) {
        db.run("UPDATE sets SET ignore_parts = ? WHERE theme_id = ?", [val, theme_id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    } else {
        db.run(`UPDATE themes SET ${field} = ? WHERE id = ?`, [val, theme_id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    }
});

// Toggle set fields (is_hidden, ignore_parts)
app.post('/admin/sets/toggle', ensureAdmin, express.json(), (req, res) => {
    const { set_num, field, value } = req.body;
    if (!set_num || !field) return res.status(400).json({ error: 'missing' });
    const val = (value === true || value === 'true' || value === 1 || value === '1') ? 1 : 0;
    const allowed = ['is_hidden','ignore_parts'];
    if (!allowed.includes(field)) return res.status(400).json({ error: 'invalid_field' });
    db.run(`UPDATE sets SET ${field} = ? WHERE set_num = ?`, [val, set_num], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- AUTENTICAÇÃO ROTAS ---
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) return res.redirect('/login?error=DadosInvalidos');
        req.logIn(user, (e) => {
            if (e) return next(e);
            const now = Date.now();
            console.log('Updating last_login for user', user.id, '->', now);
            db.run("UPDATE users SET last_login = ? WHERE id = ?", [now, user.id], (dbErr) => {
                if (dbErr) console.error('last_login update error', dbErr);
                else console.log('last_login updated for', user.id);
                return res.redirect('/');
            });
        });
    })(req, res, next);
});
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
    // Use explicit callback to handle strategy errors gracefully
    app.get('/auth/google/callback', (req, res, next) => {
        // Dump incoming query (code/state/error) to help debug token exchange issues
        console.log('Google callback req.query:', util.inspect(req.query, { depth: 2 }));

        passport.authenticate('google', (err, user, info) => {
            // If there's an error but a user was returned, proceed but log a warning and dump details.
            if (err && !user) {
                console.error('Google auth error (fatal):', util.inspect(err, { depth: null }));
                if (err && err.data) console.error('Google error data:', util.inspect(err.data, { depth: null }));
                console.error('Google auth info (if any):', util.inspect(info, { depth: 3 }));
                console.error('Incoming headers (subset):', {
                    host: req.headers.host,
                    referer: req.headers.referer,
                    'user-agent': req.headers['user-agent']
                });
                return res.redirect('/login?error=google_error');
            }
            if (err && user) {
                console.warn('Google auth returned an error but also a user — proceeding. Error dump:', util.inspect(err, { depth: null }));
                if (err && err.data) console.warn('Google error data:', util.inspect(err.data, { depth: null }));
            }

            if (!user) {
                console.error('Google auth returned no user. Info:', util.inspect(info, { depth: 3 }));
                return res.redirect('/login?error=google_failed');
            }

            req.logIn(user, (e) => {
                if (e) { console.error('Login after Google error', e); return res.redirect('/login?error=login_failed'); }
                console.log('Google login successful for user', user.id);
                const now = Date.now();
                db.run("UPDATE users SET last_login = ? WHERE id = ?", [now, user.id], (dbErr) => {
                    if (dbErr) console.error('last_login update after Google error', dbErr);
                    return res.redirect('/');
                });
            });
        })(req, res, next);
    });
} else {
    // Provide safe fallback routes when Google OAuth is not configured
    app.get('/auth/google', (req, res) => res.redirect('/login?error=google_not_configured'));
    app.get('/auth/google/callback', (req, res) => res.redirect('/login?error=google_not_configured'));
}
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// --- SET DETAIL ---
app.get('/set/:set_num', (req, res) => {
    const setNum = req.params.set_num;
    db.get("SELECT s.*, t.name as theme_name FROM sets s LEFT JOIN themes t ON s.theme_id = t.id WHERE s.set_num = ?", [setNum], (err, set) => {
        if (err) {
            console.error('❌ Set detail query error:');
            console.error('Set num:', setNum);
            console.error('Error:', err);
            return res.status(500).send('Erro BD');
        }
        if (!set) {
            // If the set isn't in our DB, redirect to search results for that set_num
            return res.redirect('/?q=' + encodeURIComponent(setNum));
        }

        if (!req.user) {
            return res.render('set_detail', { set, user: null });
        }

        db.get("SELECT * FROM user_sets WHERE user_id = ? AND set_num = ?", [req.user.id, set.set_num], (e, us) => {
            if (us) {
                set.user_status = us.status;
                set.location = us.location;
                set.build_status = us.build_status;
                set.purchase_price = us.purchase_price;
                set.quantity = us.quantity;
            } else {
                set.user_status = null;
            }
            res.render('set_detail', { set, user: req.user });
        });
    });
});

// Update user-set details (from set_detail page)
app.post('/api/user_set/update', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    const { set_num, build_status, location, purchase_price, price_eur, quantity } = req.body;
    const qty = quantity ? parseInt(quantity) : 1;

    db.run(`INSERT INTO user_sets (user_id, set_num, quantity, status, location, build_status, purchase_price) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, set_num) DO UPDATE SET quantity = excluded.quantity, status = excluded.status, location = excluded.location, build_status = excluded.build_status, purchase_price = excluded.purchase_price`,
        [req.user.id, set_num, qty, 'OWNED', location || null, build_status || null, purchase_price || null], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Iniciar Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor a rodar na porta ${PORT}`));
