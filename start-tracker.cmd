@echo off
cd /d "%~dp0"
node --no-warnings scripts\start-bg.mjs --open
if errorlevel 1 pause
