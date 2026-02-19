# LegoCollector - Requirements

## System Requirements

- **Node.js**: v20.x or higher
- **NPM**: v10.x or higher
- **Operating System**: Windows, Linux, or macOS
- **Database**: SQLite 3.x (bundled with sqlite3 npm package)

## Node.js Dependencies

### Core Framework
- **express** (^4.18.2) - Web application framework
- **ejs** (^3.1.9) - Embedded JavaScript templating

### Authentication & Security
- **passport** (^0.7.0) - Authentication middleware
- **passport-local** (^1.0.0) - Local authentication strategy
- **passport-google-oauth20** (^2.0.0) - Google OAuth 2.0 authentication
- **bcrypt** (^6.0.0) - Password hashing
- **express-session** (^1.19.0) - Session middleware

### Database
- **sqlite3** (^5.1.6) - SQLite database driver
- **connect-sqlite3** (^0.9.16) - SQLite session store for Express

### File Handling
- **multer** (^2.0.2) - Multipart/form-data file upload handling
- **csv-parser** (^3.2.0) - CSV file parsing

### HTTP & API
- **axios** (^1.6.0) - HTTP client
- **node-fetch** (^2.7.0) - Fetch API for Node.js
- **fetch-cookie** (^2.2.0) - Cookie support for fetch
- **tough-cookie** (^6.0.0) - Cookie parsing and handling

### Utilities
- **dotenv** (^16.3.1) - Environment variable management
- **node-cron** (^3.0.3) - Cron job scheduler
- **nodemailer** (^8.0.1) - Email sending

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
# Email Configuration (Optional - for password reset/verification)
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# Google OAuth (Optional - for Google login)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Server Configuration
PORT=3000
```

## Database Files

The application creates and manages the following SQLite databases:
- **lego.db** - Main application database (sets, themes, users, barcodes)
- **sessions.db** - Session storage

## Installation

```bash
npm install
```

## Running the Application

```bash
# Start the server
npm start

# Run data synchronization
npm run sync
```

## Port Requirements

- **Default Port**: 3000 (configurable via PORT environment variable)
- Ensure the port is available and not blocked by firewall

## Browser Compatibility

- Modern browsers supporting ES6+ JavaScript
- Camera access required for barcode scanning feature
- Supports both light and dark modes

## Additional Notes

- First user registered (ID=1) automatically becomes admin
- Barcode scanning requires HTTPS in production (camera access)
- Automatic daily data synchronization scheduled at 04:00
