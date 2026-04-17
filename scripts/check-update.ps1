# ============================================================
# FRC Filial Server — Auto-Update Script (Windows)
# Runs via Task Scheduler every 15 minutes
# Usage: powershell -ExecutionPolicy Bypass -File C:\frc-filial\check-update.ps1
# ============================================================

$ErrorActionPreference = "Stop"

$BASE_DIR = "C:\frc-filial"
$RELEASES_DIR = "$BASE_DIR\releases"
$CURRENT_LINK = "$BASE_DIR\current"
$VERSION_FILE = "$BASE_DIR\.current-version"
$CHANNEL_FILE = "$BASE_DIR\.channel"
$TOKEN_FILE = "$BASE_DIR\.github-token"
$FILIAL_ID_FILE = "$BASE_DIR\.filial-id"
$LOG_FILE = "$BASE_DIR\logs\update.log"
$JAR_NAME = "frc-filial-server.jar"
$SERVICE_NAME = "frc-filial"
$REPO = "GabFrank/franco-system-backend-filial"
$JAVA_EXE = "java"

# Read port from .env
$HEALTH_PORT = "8080"
$envContent = Get-Content "$BASE_DIR\.env" -ErrorAction SilentlyContinue
foreach ($line in $envContent) {
    if ($line -match "^SERVER_PORT=(.+)") { $HEALTH_PORT = $Matches[1].Trim() }
}
$HEALTH_URL = "http://localhost:$HEALTH_PORT/actuator/health"
$HEALTH_TIMEOUT = 120
$HEALTH_INTERVAL = 5

# --- Logging ---
function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$ts] $msg"
    Write-Host $entry
    Add-Content -Path $LOG_FILE -Value $entry
}

Log "========== Update Check =========="

# --- Validations ---
if (-not (Test-Path $CHANNEL_FILE)) { Log "ERROR: Channel file not found"; exit 1 }
if (-not (Test-Path $TOKEN_FILE)) { Log "ERROR: Token file not found"; exit 1 }

$CHANNEL = (Get-Content $CHANNEL_FILE).Trim()
$TOKEN = (Get-Content $TOKEN_FILE).Trim()
$FILIAL_ID = if (Test-Path $FILIAL_ID_FILE) { (Get-Content $FILIAL_ID_FILE).Trim() } else { $env:COMPUTERNAME }
$CURRENT_VERSION = if (Test-Path $VERSION_FILE) { (Get-Content $VERSION_FILE).Trim() } else { "none" }

Log "Filial: $FILIAL_ID"
Log "Channel: $CHANNEL"
Log "Current version: $CURRENT_VERSION"

# --- GitHub API headers ---
$headers = @{
    "Authorization" = "token $TOKEN"
    "Accept" = "application/vnd.github.v3+json"
}

# --- Determine latest release ---
try {
    if ($CHANNEL -eq "stable") {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" -Headers $headers
        $LATEST = $release.tag_name
    } else {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases" -Headers $headers
        $filtered = $releases | Where-Object { $_.prerelease -eq $true -and $_.tag_name -like "*$CHANNEL*" } | Select-Object -First 1
        $LATEST = $filtered.tag_name
    }
} catch {
    Log "ERROR: Failed to query GitHub API: $_"
    exit 1
}

if (-not $LATEST) { Log "No release found for channel '$CHANNEL'. Skipping."; exit 0 }

$LATEST_VERSION = $LATEST -replace "^v", ""
Log "Latest version for ${CHANNEL}: $LATEST_VERSION"

if ($CURRENT_VERSION -eq $LATEST_VERSION) { Log "Already up to date. Nothing to do."; exit 0 }

Log "New version available: $LATEST_VERSION (current: $CURRENT_VERSION)"

# --- Download JAR ---
$RELEASE_DIR = "$RELEASES_DIR\$LATEST_VERSION"
New-Item -ItemType Directory -Path $RELEASE_DIR -Force | Out-Null

Log "Downloading $JAR_NAME from release $LATEST..."
try {
    $releaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/tags/$LATEST" -Headers $headers
    $asset = $releaseInfo.assets | Where-Object { $_.name -eq $JAR_NAME } | Select-Object -First 1
    if (-not $asset) { Log "ERROR: JAR asset not found in release"; exit 1 }

    $downloadHeaders = @{
        "Authorization" = "token $TOKEN"
        "Accept" = "application/octet-stream"
    }
    Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile "$RELEASE_DIR\$JAR_NAME"
    $size = [math]::Round((Get-Item "$RELEASE_DIR\$JAR_NAME").Length / 1MB, 1)
    Log "Downloaded to $RELEASE_DIR\$JAR_NAME (${size}MB)"
} catch {
    Log "ERROR: Download failed: $_"
    exit 1
}

# --- Deploy ---
$PREVIOUS_VERSION = $CURRENT_VERSION

# Update symlink (junction on Windows)
Log "Updating junction: current -> $RELEASE_DIR"
if (Test-Path $CURRENT_LINK) {
    cmd /c rmdir "$CURRENT_LINK" 2>$null
    Remove-Item $CURRENT_LINK -Force -ErrorAction SilentlyContinue
}
cmd /c mklink /J "$CURRENT_LINK" "$RELEASE_DIR"
Set-Content -Path $VERSION_FILE -Value $LATEST_VERSION

# Restart service
Log "Restarting $SERVICE_NAME..."
$javaProcess = Get-Process -Name "java" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*frc-filial*" -or $_.Path -like "*frc-filial*"
}
if ($javaProcess) {
    Stop-Process -Id $javaProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Read .env and build Spring properties as -D flags
$envArgs = @()
foreach ($line in (Get-Content "$BASE_DIR\.env")) {
    if ($line -match "^([^=]+)=(.*)$") {
        $key = $Matches[1].Trim()
        $val = $Matches[2].Trim()
        # Convert SPRING_DATASOURCE_URL to spring.datasource.url format
        $prop = $key.ToLower().Replace("_", ".")
        $envArgs += "-D$prop=$val"
    }
}
$envString = $envArgs -join " "

# Start Java process with properties
$jarPath = "$CURRENT_LINK\$JAR_NAME"
$allArgs = "$envString -jar `"$jarPath`""
Start-Process -FilePath $JAVA_EXE -ArgumentList $allArgs -WorkingDirectory $BASE_DIR -WindowStyle Hidden -RedirectStandardOutput "$BASE_DIR\logs\app.log" -RedirectStandardError "$BASE_DIR\logs\app-error.log"

# --- Health check ---
Log "Waiting for health check at $HEALTH_URL (timeout: ${HEALTH_TIMEOUT}s)..."
$elapsed = 0
while ($elapsed -lt $HEALTH_TIMEOUT) {
    Start-Sleep -Seconds $HEALTH_INTERVAL
    $elapsed += $HEALTH_INTERVAL

    try {
        $response = Invoke-WebRequest -Uri $HEALTH_URL -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        $status = $response.StatusCode
    } catch {
        $status = 0
    }

    if ($status -eq 200 -or $status -eq 503) {
        Log "Health check PASSED (HTTP $status) at ${elapsed}s"
        Log "Successfully updated to $LATEST_VERSION"

        # Notify GitHub
        try {
            $deployBody = @{
                ref = "v$LATEST_VERSION"
                environment = $FILIAL_ID
                auto_merge = $false
                required_contexts = @()
                description = "Auto-update $FILIAL_ID to $LATEST_VERSION"
            } | ConvertTo-Json
            $deploy = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/deployments" -Method Post -Headers $headers -Body $deployBody -ContentType "application/json"
            $statusBody = @{ state = "success"; description = "Health check passed (HTTP $status)" } | ConvertTo-Json
            Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/deployments/$($deploy.id)/statuses" -Method Post -Headers $headers -Body $statusBody -ContentType "application/json" | Out-Null
            Log "GitHub deployment notified: $FILIAL_ID -> $LATEST_VERSION (success)"
        } catch {
            Log "WARNING: GitHub notification failed: $_"
        }
        exit 0
    }
}

# --- Rollback ---
Log "ERROR: Health check failed after ${HEALTH_TIMEOUT}s"

if ($PREVIOUS_VERSION -ne "none" -and (Test-Path "$RELEASES_DIR\$PREVIOUS_VERSION")) {
    Log "Rolling back to $PREVIOUS_VERSION..."
    $javaProcess = Get-Process -Name "java" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like "*frc-filial*"
    }
    if ($javaProcess) { Stop-Process -Id $javaProcess.Id -Force -ErrorAction SilentlyContinue }

    cmd /c rmdir "$CURRENT_LINK" 2>$null
    cmd /c mklink /J "$CURRENT_LINK" "$RELEASES_DIR\$PREVIOUS_VERSION"
    Set-Content -Path $VERSION_FILE -Value $PREVIOUS_VERSION

    Start-Process -FilePath $JAVA_EXE -ArgumentList "$envString -jar `"$CURRENT_LINK\$JAR_NAME`"" -WorkingDirectory $BASE_DIR -WindowStyle Hidden
    Log "Rollback complete. Restarted with version $PREVIOUS_VERSION"

    # Notify GitHub failure
    try {
        $deployBody = @{ ref = "v$LATEST_VERSION"; environment = $FILIAL_ID; auto_merge = $false; required_contexts = @(); description = "Auto-update $FILIAL_ID to $LATEST_VERSION" } | ConvertTo-Json
        $deploy = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/deployments" -Method Post -Headers $headers -Body $deployBody -ContentType "application/json"
        $statusBody = @{ state = "failure"; description = "Health check failed, rolled back to $PREVIOUS_VERSION" } | ConvertTo-Json
        Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/deployments/$($deploy.id)/statuses" -Method Post -Headers $headers -Body $statusBody -ContentType "application/json" | Out-Null
    } catch {}
} else {
    Log "WARNING: No previous version to rollback to."
}

exit 1
