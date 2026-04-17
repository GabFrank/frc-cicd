# Start FRC Filial Server with environment from .env
$BASE_DIR = "C:\frc-filial"
$JAR = "$BASE_DIR\current\frc-filial-server.jar"

# Read .env and build -D flags
$envArgs = @()
foreach ($line in (Get-Content "$BASE_DIR\.env")) {
    if ($line -match "^([^=]+)=(.*)$") {
        $key = $Matches[1].Trim()
        $val = $Matches[2].Trim()
        $prop = $key.ToLower().Replace("_", ".")
        $envArgs += "-D$prop=$val"
    }
}

$allArgs = ($envArgs -join " ") + " -jar `"$JAR`""

# Start without redirect (logs go to nssm/task scheduler)
Start-Process -FilePath "java" -ArgumentList $allArgs -WorkingDirectory $BASE_DIR -WindowStyle Hidden -PassThru | Out-Null
