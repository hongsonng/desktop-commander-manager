@chcp 65001 >nul
@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ComSpec=%SystemRoot%\System32\cmd.exe"
set "COMSPEC=%ComSpec%"
for /F "delims=" %%E in ('powershell -NoProfile -Command "[char]27"') do set "ESC=%%E"
set "RESET=!ESC![0m"
set "BOLD=!ESC![1m"
set "BLUE=!ESC![94m"
set "CYAN=!ESC![96m"
set "GREEN=!ESC![92m"
set "YELLOW=!ESC![93m"
set "RED=!ESC![91m"

title Cai dat Desktop Commander Manager tu khoi dong
cls
echo.
echo !CYAN!!BOLD!==============================================================!RESET!
echo !BLUE!!BOLD!       CÀI ĐẶT DESKTOP COMMANDER MANAGER TỰ KHỞI ĐỘNG!RESET!
echo !CYAN!!BOLD!==============================================================!RESET!
echo.

echo !BLUE![1/4]!RESET! Kiểm tra Node.js và npm...
where node >nul 2>&1 || goto :missing_node
where npm >nul 2>&1 || goto :missing_npm
echo !GREEN![OK]!RESET! Môi trường Node/npm sẵn sàng.

echo.
echo !BLUE![2/4]!RESET! Cài/cập nhật dependencies...
call npm install
if errorlevel 1 goto :failed
echo !GREEN![OK]!RESET! Dependencies sẵn sàng.

echo.
echo !BLUE![3/4]!RESET! Build manager/dashboard...
call npm run build
if errorlevel 1 goto :failed
echo !GREEN![OK]!RESET! Build thành công.

echo.
echo !BLUE![4/4]!RESET! Đăng ký Windows Task Scheduler...
call npm run autostart:install
if errorlevel 1 goto :failed

echo.
call npm run autostart:status

echo.
echo !GREEN!!BOLD!Cài đặt tự khởi động hoàn tất.!RESET!
echo !GREEN!Manager sẽ tự chạy khi đăng nhập Windows và đã được khởi động ngay bây giờ.!RESET!
echo.
where tunnel-client >nul 2>&1
if errorlevel 1 (
    echo !YELLOW![!] Chưa tìm thấy tunnel-client.!RESET!
    echo !YELLOW!    Manager local vẫn tự chạy. Để ChatGPT kết nối tự động từ xa,!RESET!
    echo !YELLOW!    cài/cấu hình OpenAI Secure MCP Tunnel một lần rồi chạy lại file này.!RESET!
) else (
    echo !GREEN![OK] Đã đăng ký Secure MCP Tunnel tự khởi động.!RESET!
    echo !YELLOW!Nếu profile desktop-commander-manager chưa cấu hình, runner sẽ chờ và tự thử lại.!RESET!
)

echo.
echo !CYAN!Dashboard: http://127.0.0.1:8788/!RESET!
echo !CYAN!MCP local : http://127.0.0.1:8787/mcp!RESET!
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8788/"
echo.
pause
exit /b 0

:missing_node
echo !RED![X] Không tìm thấy Node.js trong PATH.!RESET!
goto :failed

:missing_npm
echo !RED![X] Không tìm thấy npm trong PATH.!RESET!
goto :failed

:failed
echo.
echo !RED!!BOLD!Cài đặt tự khởi động thất bại. Xem lỗi phía trên.!RESET!
echo.
pause
exit /b 1
