@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ==============================================================
echo        CẤU HÌNH OPENAI SECURE MCP TUNNEL
echo ==============================================================
echo.
echo Script sẽ yêu cầu Tunnel ID và Runtime API key.
echo API key được nhập ẩn và lưu ngoài repo trong %%APPDATA%%\tunnel-client\secrets.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-tunnel.ps1"
if errorlevel 1 goto :failed

echo.
echo Cấu hình tunnel hoàn tất.
pause
exit /b 0

:failed
echo.
echo Không thể hoàn tất cấu hình tunnel. Xem lỗi phía trên.
pause
exit /b 1
