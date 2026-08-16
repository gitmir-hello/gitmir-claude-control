@echo off
REM Puts a "GitMir Local" shortcut on your Desktop (Windows).
REM
REM start.cmd works but keeps a console window open, and closing that window stops the
REM dashboard. This creates an ordinary .lnk shortcut instead: double-clicking it starts
REM the dashboard with no window and opens your browser, and if it is already running it
REM simply opens the browser.
REM
REM Run it once: double-click this file.
setlocal
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

echo Dashboard folder: %DIR%

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install it from https://nodejs.org
  echo   Node 18+ runs the dashboard; the optional Team bridge needs Node 22+.
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%i in ('node -v') do echo node:             %%i

powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir='%DIR%'; $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GitMir Local.lnk'; $w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut($lnk); $s.TargetPath = (Get-Command powershell).Source; $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $dir 'launch.ps1') + '\"'; $s.WorkingDirectory = $dir; $s.Description = 'Start GitMir Local and open it in the browser'; $ico = Join-Path $dir 'vendor\gitmir.ico'; if (Test-Path $ico) { $s.IconLocation = $ico }; $s.WindowStyle = 7; $s.Save(); Write-Host ('Shortcut created: ' + $lnk)"

echo.
echo Double-click "GitMir Local" on your Desktop: the dashboard starts with no
echo window and your browser opens. It keeps running after you close the browser.
echo To stop it:  taskkill /IM node.exe /F
echo.
echo To use a different port, set GITMIR_PORT before launching, e.g. in a terminal:
echo   setx GITMIR_PORT 4600
echo.
pause
