@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"
npm run dev -- -- %*
exit %errorlevel%
