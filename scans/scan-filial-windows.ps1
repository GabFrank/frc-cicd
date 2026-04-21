# Escaneo SOLO LECTURA de filial Windows farmacia.
# Ejecutar desde PowerShell del operador (Mac/Win), requiere OpenSSH configurado.
# Uso: ./scan-filial-windows.ps1 -IP 172.25.3.2 -User franco | Tee-Object -FilePath farmacia-$(Get-Date -Format yyyy-MM-dd)/filial-2.txt

param(
  [Parameter(Mandatory=$true)][string]$IP,
  [string]$User = "franco"
)

Write-Host "##############################################"
Write-Host "# Scan filial windows $IP  $(Get-Date)"
Write-Host "##############################################"

$remote = @'
Write-Host "=== HOSTNAME / OS ==="
hostname
[System.Environment]::OSVersion
Write-Host ""
Write-Host "=== Java ==="
(java -version 2>&1) | Select-Object -First 2

Write-Host ""
Write-Host "=== Servicios Windows FRC ==="
Get-Service frc* -ErrorAction SilentlyContinue | Format-Table -AutoSize

Write-Host ""
Write-Host "=== Paths ==="
Write-Host "--- C:\FRC ---"
Get-ChildItem C:\FRC -ErrorAction SilentlyContinue | Select-Object Mode, Length, Name | Format-Table -AutoSize
Write-Host "--- C:\opt\frc-filial ---"
Get-ChildItem C:\opt\frc-filial -ErrorAction SilentlyContinue | Select-Object Mode, Length, Name | Format-Table -AutoSize
Write-Host "--- C:\Users\franco\FRC ---"
Get-ChildItem C:\Users\franco\FRC -ErrorAction SilentlyContinue | Select-Object Mode, Length, Name | Format-Table -AutoSize

Write-Host ""
Write-Host "=== Task Scheduler (equivalente a cron) ==="
Get-ScheduledTask | Where-Object TaskName -like "*frc*" | Format-Table TaskName, State, TaskPath -AutoSize

Write-Host ""
Write-Host "=== Postgres Windows ==="
Get-Service postgresql* -ErrorAction SilentlyContinue | Format-Table -AutoSize

Write-Host ""
Write-Host "=== Current version ==="
if (Test-Path C:\opt\frc-filial\.current-version) { Get-Content C:\opt\frc-filial\.current-version } else { Write-Host "no .current-version" }

Write-Host ""
Write-Host "=== Canal / filial-id / token ==="
foreach ($f in ".channel", ".filial-id", ".github-token") {
  $p = "C:\opt\frc-filial\$f"
  if (Test-Path $p) { Write-Host "$f exists ($((Get-Item $p).Length) bytes)" } else { Write-Host "$f MISSING" }
}

Write-Host ""
Write-Host "=== check-update.ps1 ==="
if (Test-Path C:\opt\frc-filial\check-update.ps1) { Write-Host "EXISTS" } else { Write-Host "MISSING" }

Write-Host ""
Write-Host "=== Actuator/info ==="
try {
  (Invoke-WebRequest -Uri http://localhost:8082/actuator/info -TimeoutSec 5 -UseBasicParsing).Content | Select-Object -First 200
} catch { Write-Host "no responde 8082" }

Write-Host ""
Write-Host "=== Firewall inbound rules FRC ==="
Get-NetFirewallRule -DisplayName "*frc*" -ErrorAction SilentlyContinue | Format-Table DisplayName, Enabled, Direction, Action -AutoSize

Write-Host ""
Write-Host "=== Puertos escuchando ==="
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8080, 8082, 5432 } | Format-Table LocalPort, OwningProcess -AutoSize

Write-Host ""
Write-Host "=== Done $(Get-Date) ==="
'@

ssh "$User@$IP" "powershell -NoProfile -Command -" <<< $remote
