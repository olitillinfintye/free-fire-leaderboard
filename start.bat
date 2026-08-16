@echo off
title Free Fire Leaderboard
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed. Get it from https://nodejs.org  then run this file again.
  pause
  exit /b 1
)
start "" http://localhost:8080/
node server.js %*
pause
