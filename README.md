# 🧱 LegoCollector

A web application for managing your LEGO collection with barcode scanning, statistics, and set tracking.

## 📋 Prerequisites

- **Node.js** v20.x or higher
- **npm** v10.x or higher
- **Git**

## 🚀 Quick Setup

### Option 1: Automated Setup (Recommended)

This automatically installs dependencies AND populates the initial database.

**Windows:**
```bash
setup.bat
```

**Linux/Mac:**
```bash
chmod +x setup.sh
./setup.sh
```

The setup script will:
1. ✅ Check Node.js installation
2. ✅ Install all npm dependencies
3. ✅ Populate initial LEGO database (may take a few minutes)

### Option 2: Manual Setup

1. **Clone the repository:**
```bash
git clone https://github.com/ColdShadow80/LegoCollector.git
cd LegoCollector
```

2. **Install dependencies:**
```bash
npm install
```

3. **Create .env file (optional):**
```bash
cp .env.example .env
```
Edit `.env` and add your configuration:
- Email settings (for password reset)
- Google OAuth credentials (for Google login)

4. **Import initial data:**
```bash
node setup_bulk.js
```

5. **Start the application:**
```bash
npm start
```

6. **Open in browser:**
```
http://localhost:3000
```

## 🐳 Docker Setup

**Important:** Before using Docker, populate the database first:
```bash
npm install
node setup_bulk.js
```

### Using Docker Compose (Recommended)

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

Or use npm scripts:
```bash
npm run docker:build
npm run docker:run
npm run docker:stop
```

### Using Docker directly

```bash
# Build image
docker build -t legocollector .

# Run container
docker run -d -p 3000:3000 \
  -v $(pwd)/lego.db:/app/lego.db \
  -v $(pwd)/sessions.db:/app/sessions.db \
  -v $(pwd)/uploads:/app/uploads \
  --name legocollector \
  legocollector
```

## 📦 Available Scripts

```bash
npm start              # Start the application server
npm run sync           # Synchronize LEGO data from Rebrickable API
npm run setup          # Install dependencies (same as npm install)
npm run docker:build   # Build Docker image
npm run docker:run     # Run with Docker Compose
npm run docker:stop    # Stop Docker containers
```

### What does `npm run sync` do?

The sync script (`sync.js`) fetches the latest LEGO set and theme data from the Rebrickable API and updates your local database. This includes:

- **Sets**: All LEGO sets with details (name, year, theme, piece count, images)
- **Themes**: LEGO themes and subthemes
- **Updates**: Price updates and new releases

**When to run it:**
- ✅ After initial setup (already done by `setup.bat`/`setup.sh`)
- ✅ Periodically to get new sets and updates (manual or automatic)
- ✅ After long periods without updates

**Important:**
- Takes 5-30 minutes depending on data volume
- Requires internet connection
- Uses Rebrickable API (no API key needed for basic sync)
- **Automatic sync**: App runs this daily at 04:00 (configured in `server.js` via cron job)

**Manual sync:**
```bash
npm run sync
```

## ⚙️ Configuration

### Environment Variables (.env)

```env
# Email Configuration (Optional)
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# Google OAuth (Optional)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Server
PORT=3000
```

## 🔑 Getting API Keys

### Rebrickable API (For data sync)

The application uses Rebrickable as its data source for LEGO sets and themes.

**For basic usage (default sync):**
- No API key required! The `setup_bulk.js` and `sync.js` scripts work without authentication
- Uses public Rebrickable CSV downloads

**For advanced features (optional):**
1. Create account at [Rebrickable.com](https://rebrickable.com/)
2. Go to [API settings](https://rebrickable.com/api/) and request a key
3. Add to your `.env` file if you want to use additional API features

**Note:** The built-in sync works out-of-the-box without any API configuration.

### Google OAuth (Optional - for Google login)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
6. Copy Client ID and Secret to `.env`

## 🚀 Production Deployment

### Prerequisites for Production

1. **Server Requirements**:
   - Linux server (Ubuntu/Debian recommended)
   - Node.js v20.x or higher installed
   - Minimum 1GB RAM
   - Port 3000 open (or configure reverse proxy)

2. **Security Setup**:
   - Configure firewall (UFW recommended)
   - Set up SSL/HTTPS with reverse proxy (Nginx/Apache)
   - Create `.env` file with production values
   - Use strong session secrets

### Option 1: PM2 Process Manager (Recommended for Linux/Mac)

PM2 keeps your app running 24/7, automatically restarts on crashes, and manages logs.

**1. Install PM2 globally:**
```bash
sudo npm install -g pm2
```

**2. Start the application:**
```bash
# Navigate to your app directory
cd /path/to/LegoCollector

# Start with PM2
pm2 start server.js --name "legocollector"
```

**3. Configure auto-start on system reboot:**
```bash
# Generate and configure startup script
pm2 startup

# This will output a command to run with sudo - execute it
# Example: sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u youruser --hp /home/youruser

# Save current PM2 process list
pm2 save
```

**4. Useful PM2 Commands:**
```bash
pm2 status                    # Check application status
pm2 logs legocollector        # View real-time logs
pm2 logs legocollector --lines 100  # View last 100 log lines
pm2 restart legocollector     # Restart application
pm2 stop legocollector        # Stop application
pm2 delete legocollector      # Remove from PM2
pm2 monit                     # Monitor CPU/RAM usage
```

**5. Update application in production:**
```bash
# Pull latest code
git pull

# Install dependencies if package.json changed
npm install

# Restart with PM2
pm2 restart legocollector
```

**6. Managing automatic sync in production:**

The app automatically syncs data daily at 04:00 thanks to the built-in cron job (configured in `server.js`). To modify the schedule:

```javascript
// In server.js, find this line:
cron.schedule('0 4 * * *', () => {  // Runs at 04:00 every day
```

Or run manual sync anytime:
```bash
npm run sync
```

### Option 2: Docker in Production

**1. Build and start:**
```bash
# Clone repository
git clone https://github.com/ColdShadow80/LegoCollector.git
cd LegoCollector

# Install dependencies and populate database on host
npm install
node setup_bulk.js

# Start with Docker Compose
docker-compose up -d --build
```

**2. Useful Docker commands:**
```bash
docker-compose logs -f           # View real-time logs
docker-compose restart           # Restart containers
docker-compose down              # Stop and remove containers
docker-compose ps                # Check container status
```

**3. Update in production:**
```bash
git pull
docker-compose up -d --build
```

### Option 3: Systemd Service (Alternative to PM2)

**1. Create service file:**
```bash
sudo nano /etc/systemd/system/legocollector.service
```

**2. Add this content** (adjust paths and user):
```ini
[Unit]
Description=LegoCollector App
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/LegoCollector
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**3. Enable and start:**
```bash
sudo systemctl enable legocollector
sudo systemctl start legocollector
sudo systemctl status legocollector
```

**4. Manage service:**
```bash
sudo systemctl restart legocollector
sudo systemctl stop legocollector
sudo journalctl -u legocollector -f  # View logs
```

### Setting up Reverse Proxy (Nginx)

For production, use Nginx as reverse proxy with SSL:

**1. Install Nginx:**
```bash
sudo apt update
sudo apt install nginx
```

**2. Create Nginx config:**
```bash
sudo nano /etc/nginx/sites-available/legocollector
```

**3. Add this configuration:**
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**4. Enable site:**
```bash
sudo ln -s /etc/nginx/sites-available/legocollector /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

**5. Add SSL with Let's Encrypt:**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Production Checklist

- [ ] Set strong session secret in production
- [ ] Configure `.env` with email settings (for password reset)
- [ ] Set up SSL/HTTPS
- [ ] Configure firewall (allow ports 80, 443, 22)
- [ ] Enable automatic backups of `lego.db` and `sessions.db`
- [ ] Set up monitoring (PM2 plus or custom)
- [ ] Test application restarts and auto-recovery
- [ ] Verify automatic daily sync is working (check logs next day)
- [ ] Configure Google OAuth callback URL for production domain
- [ ] Set up log rotation to prevent disk space issues

### Backup Database

**Automated backup script** (optional):
```bash
#!/bin/bash
# backup-lego.sh
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/path/to/backups
cp /path/to/LegoCollector/lego.db $BACKUP_DIR/lego_$DATE.db
cp /path/to/LegoCollector/sessions.db $BACKUP_DIR/sessions_$DATE.db
# Keep only last 7 days
find $BACKUP_DIR -name "lego_*.db" -mtime +7 -delete
find $BACKUP_DIR -name "sessions_*.db" -mtime +7 -delete
```

**Add to crontab** for daily backups:
```bash
crontab -e
# Add: 0 3 * * * /path/to/backup-lego.sh
```

## 📱 Features

- 📊 Collection statistics and analytics
- 🔍 Advanced search and filtering
- 📸 Barcode scanner for quick set lookup
- 👥 User authentication (local + Google OAuth)
- 🎨 Dark/Light mode
- 📥 Import/Export collection data
- 🏷️ Set status tracking (Owned, Wanted)
- 🔄 Automatic daily data synchronization
- 📧 Email notifications and password reset
- 👨‍💼 Admin panel for managing sets, themes, and barcodes

## 🛠️ Tech Stack

- **Backend**: Node.js, Express
- **Database**: SQLite
- **Authentication**: Passport.js (Local + Google OAuth)
- **Frontend**: EJS templates, Bootstrap 5
- **Barcode Scanning**: html5-qrcode
- **Process Management**: PM2 (production)
- **Scheduled Tasks**: node-cron

## 📄 License

See [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📞 Support

If you encounter any issues:
1. Check the logs (PM2: `pm2 logs legocollector`)
2. Verify `.env` configuration
3. Ensure database files exist and have proper permissions
4. Check Node.js version compatibility
5. Open an issue on GitHub with details
