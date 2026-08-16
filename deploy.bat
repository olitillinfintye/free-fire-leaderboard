@echo off
title Free Fire Leaderboard - LIVE
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed. Get it from https://nodejs.org  then run this again.
  pause
  exit /b 1
)
node tools\deploy.js
pause
