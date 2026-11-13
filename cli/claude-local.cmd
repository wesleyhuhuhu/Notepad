@echo off
rem Runs claude-local.ps1 without changing PowerShell's script policy. Arguments pass through.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-local.ps1" %*
