@echo off
cd /d "%~dp0web"
call npm run stop >nul 2>&1
if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
)
if not exist "src\data\missions.json" (
  echo Building game data...
  call npm run build:data
)
if not exist ".env" (
  echo Creating .env from .env.example...
  copy /Y ".env.example" ".env" >nul
)
echo Starting game at http://127.0.0.1:5173
call npm run dev
