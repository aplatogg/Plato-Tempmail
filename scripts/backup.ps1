#requires -Version 7
param([string]$OutRoot = "backups")
$ErrorActionPreference = "Stop"
if (-not $env:CLOUDFLARE_API_TOKEN) { throw "Set CLOUDFLARE_API_TOKEN first." }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dir = Join-Path $OutRoot "full-$stamp"
New-Item -ItemType Directory -Path $dir -Force | Out-Null

Write-Host "Exporting D1..."
npx wrangler d1 export DB --remote --output (Join-Path $dir "d1-plato.sql")
if ($LASTEXITCODE -ne 0) { throw "D1 export failed." }

Write-Host "Zipping source..."
$root = Split-Path $PSScriptRoot -Parent
$skip = @('node_modules', '.wrangler', 'dist', 'backups', '.taste-skill', 'test-results', 'playwright-report', '.git')
$temp = Join-Path $env:TEMP ("plato-src-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  foreach ($item in Get-ChildItem $root -Force) {
    if ($skip -contains $item.Name) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $temp -Recurse -Force
  }
  Compress-Archive -Path (Join-Path $temp '*') -DestinationPath (Join-Path $dir 'source.zip') -CompressionLevel Optimal
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Backup at $dir"
