@echo off
echo ========================================
echo LegoCollector Setup
echo ========================================
echo.

echo Checking Node.js installation...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js v20.x or higher from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js detected: 
node --version
echo.

echo Installing npm dependencies...
npm install
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install dependencies!
    echo Please check your internet connection and try again.
    pause
    exit /b %errorlevel%
)

echo.
echo ========================================
echo Populating initial database...
echo ========================================
echo.
echo This may take a few minutes. Please wait...
echo.

node setup_bulk.js
if %errorlevel% neq 0 (
    echo.
    echo WARNING: Database population failed or was skipped.
    echo You can run 'node setup_bulk.js' manually later.
    echo.
)

echo.
echo ========================================
echo Setup completed successfully!
echo ========================================
echo.
echo Next steps:
echo 1. Create a .env file with your configuration (optional)
echo 2. Run 'npm start' to launch the application
echo 3. Open http://localhost:3000 in your browser
echo 4. First user registered (ID=1) will be admin
echo.
pause
