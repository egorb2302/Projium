@echo off
cd /d "%~dp0"
netstat -ano | findstr /r /c:"127.0.0.1:3210 .*LISTENING" >nul || start "tracker" /min node --no-warnings server.mjs
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:3210/
