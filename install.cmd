@echo off
rem ============================================================
rem  dsh-recall-channel - install / version switcher (wrapper)
rem  Double-click to install THIS folder's version. Running the
rem  other version's install.cmd switches / rolls back.
rem  Optional: install.cmd -DshRoot "D:\...\DeepSeek Harness"
rem
rem  NOTE: keep this file ASCII-only and CRLF-terminated.
rem  cmd.exe parses .cmd files using the console code page, so a
rem  non-ASCII comment followed by an LF-only newline can be
rem  swallowed into a double-byte character and the line gets split
rem  ("... is not recognized as an internal or external command").
rem  All Chinese prompts live in install.ps1 (UTF-8 with BOM).
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%