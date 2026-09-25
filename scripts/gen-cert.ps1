# Membuat sertifikat self-signed untuk pengembangan (HTTPS lokal) - Windows PowerShell
param([string]$HostName = "localhost")
$dir = Join-Path (Split-Path $PSScriptRoot -Parent) "nginx\certs"
New-Item -ItemType Directory -Force $dir | Out-Null
& openssl req -x509 -nodes -newkey rsa:2048 -days 825 `
  -keyout "$dir\server.key" -out "$dir\server.crt" `
  -subj "/C=ID/ST=Jakarta/O=QuadranGIS/CN=$HostName" `
  -addext "subjectAltName=DNS:$HostName,DNS:localhost,IP:127.0.0.1"
Write-Host "Sertifikat dibuat di $dir (server.crt, server.key)"
