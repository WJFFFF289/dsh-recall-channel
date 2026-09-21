@echo off
rem 双击本文件即可安装 dsh-recall-channel 到本机 DeepSeek Harness。
rem 也可以带参数：install.cmd -DshRoot "D:\...\DeepSeek Harness"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
