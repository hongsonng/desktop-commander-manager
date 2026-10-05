@chcp 65001 >nul
@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ComSpec=%SystemRoot%\System32\cmd.exe"
set "COMSPEC=%ComSpec%"
for /F "delims=" %%E in ('powershell -NoProfile -Command "[char]27"') do set "ESC=%%E"
set "RESET=!ESC![0m"
set "BOLD=!ESC![1m"
set "GREEN=!ESC![92m"
set "YELLOW=!ESC![93m"
set "RED=!ESC![91m"
set "CYAN=!ESC![96m"

title Go Desktop Commander Manager tu khoi dong
cls
echo.
echo !CYAN!!BOLD!==============================================================!RESET!
echo !CYAN!!BOLD!          GỠ DESKTOP COMMANDER MANAGER TỰ KHỞI ĐỘNG!RESET!
echo !CYAN!!BOLD!==============================================================!RESET!
echo.

if not exist "node_modules\.package-lock.json" (
    echo !YELLOW![!] Chưa có dependencies, chạy npm install để dùng CLI gỡ task.!RESET!
    call npm install
    if errorlevel 1 goto :failed
)

call npm run autostart:uninstall
if errorlevel 1 goto :failed

echo.
echo !GREEN!!BOLD!Đã gỡ các task tự khởi động của manager và tunnel.!RESET!
echo !YELLOW!Các process đang chạy hiện tại không bị kill; đóng chúng nếu bạn muốn dừng ngay.!RESET!
echo.
pause
exit /b 0

:failed
echo.
echo !RED!!BOLD!Không thể gỡ task tự khởi động. Xem lỗi phía trên.!RESET!
echo.
pause
exit /b 1
