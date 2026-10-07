@chcp 65001 >nul
@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Luon chay tu thu muc chua file BAT.
cd /d "%~dp0"
set "ComSpec=%SystemRoot%\System32\cmd.exe"
set "COMSPEC=%ComSpec%"
if exist "%LOCALAPPDATA%\Programs\OpenAI\tunnel-client" set "PATH=%PATH%;%LOCALAPPDATA%\Programs\OpenAI\tunnel-client"

rem Lay ky tu ESC bang PowerShell de tao mau ANSI on dinh tren Windows 10/11.
for /F "delims=" %%E in ('powershell -NoProfile -Command "[char]27"') do set "ESC=%%E"
set "C_RESET=!ESC![0m"
set "C_BOLD=!ESC![1m"
set "C_BLUE=!ESC![94m"
set "C_CYAN=!ESC![96m"
set "C_GREEN=!ESC![92m"
set "C_YELLOW=!ESC![93m"
set "C_RED=!ESC![91m"
set "C_GRAY=!ESC![90m"

title Desktop Commander Manager

cls
echo.
echo !C_CYAN!!C_BOLD!==============================================================!C_RESET!
echo !C_BLUE!!C_BOLD!              DESKTOP COMMANDER MANAGER!C_RESET!
echo !C_CYAN!!C_BOLD!==============================================================!C_RESET!
echo !C_GRAY!Thu muc: %CD%!C_RESET!
echo.

call :info "Đang kiểm tra môi trường..."
where node >nul 2>&1
if errorlevel 1 goto :node_missing
where npm >nul 2>&1
if errorlevel 1 goto :npm_missing

for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
for /f "delims=" %%V in ('npm --version') do set "NPM_VERSION=%%V"
call :ok "Node !NODE_VERSION!  -  npm !NPM_VERSION!"

if not exist "node_modules\.package-lock.json" (
    echo.
    call :warn "Chưa có dependencies. Đang chạy npm install..."
    call npm install
    if errorlevel 1 goto :install_failed
    call :ok "Cài dependencies thành công."
) else (
    call :ok "Dependencies đã sẵn sàng."
)

if not exist "apps\dashboard\dist\index.html" (
    echo.
    call :warn "Chưa có dashboard build. Đang build lần đầu..."
    call npm run build
    if errorlevel 1 goto :build_failed
    call :ok "Build thành công."
) else (
    call :ok "Dashboard build đã sẵn sàng."
)

powershell -NoProfile -Command "$busy = 8787,8788 | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue }; if ($busy) { exit 1 }"
if errorlevel 1 goto :port_in_use

echo.
echo !C_CYAN!--------------------------------------------------------------!C_RESET!
call :ok "Sẵn sàng khởi động."
echo !C_BOLD!  Dashboard : !C_GREEN!http://127.0.0.1:8788/!C_RESET!
echo !C_BOLD!  MCP       : !C_GREEN!http://127.0.0.1:8787/mcp!C_RESET!
echo !C_GRAY!  Nhấn Ctrl+C để dừng manager.!C_RESET!
echo !C_CYAN!--------------------------------------------------------------!C_RESET!
echo.

call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    call :ok "Manager đã dừng."
) else (
    call :error "Manager đã dừng với mã lỗi %EXIT_CODE%."
)
echo.
pause
exit /b %EXIT_CODE%

:node_missing
call :error "Không tìm thấy Node.js trong PATH."
echo !C_YELLOW!Cài Node.js 22+ rồi chạy lại file này.!C_RESET!
goto :fatal

:npm_missing
call :error "Không tìm thấy npm trong PATH."
echo !C_YELLOW!Cài npm rồi chạy lại file này.!C_RESET!
goto :fatal

:install_failed
call :error "npm install thất bại."
goto :fatal

:build_failed
call :error "npm run build thất bại."
goto :fatal

:port_in_use
call :error "Cổng 8787 hoặc 8788 đang được sử dụng."
echo !C_YELLOW!Có thể manager đã chạy ở cửa sổ khác. Hãy đóng tiến trình đang giữ cổng rồi thử lại.!C_RESET!
goto :fatal

:fatal
echo.
echo !C_RED!!C_BOLD!Không thể khởi động Desktop Commander Manager.!C_RESET!
echo.
pause
exit /b 1

:info
echo !C_BLUE![i]!C_RESET! %~1
exit /b 0

:ok
echo !C_GREEN![OK]!C_RESET! %~1
exit /b 0

:warn
echo !C_YELLOW![!]!C_RESET! %~1
exit /b 0

:error
echo !C_RED![X]!C_RESET! %~1
exit /b 0
