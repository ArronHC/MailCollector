Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$errors = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

$mode = ($env:WINDOWS_SIGNING_MODE ?? "none").Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = "none" }
if ($mode -notin @("none", "azure", "pfx", "auto")) {
    $errors.Add("WINDOWS_SIGNING_MODE must be none, azure, pfx, or auto")
}

$azureValues = @{
    AZURE_CLIENT_ID = $env:AZURE_CLIENT_ID
    AZURE_CLIENT_SECRET = $env:AZURE_CLIENT_SECRET
    AZURE_TENANT_ID = $env:AZURE_TENANT_ID
    AZURE_ARTIFACT_SIGNING_ENDPOINT = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT
    AZURE_ARTIFACT_SIGNING_ACCOUNT = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT
    AZURE_ARTIFACT_SIGNING_PROFILE = $env:AZURE_ARTIFACT_SIGNING_PROFILE
}
$pfxValues = @{
    WINDOWS_CERTIFICATE = $env:WINDOWS_CERTIFICATE
    WINDOWS_CERTIFICATE_PASSWORD = $env:WINDOWS_CERTIFICATE_PASSWORD
    WINDOWS_TIMESTAMP_URL = $env:WINDOWS_TIMESTAMP_URL
}

$azureReady = ($azureValues.Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0
$pfxReady = ($pfxValues.Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0

if ($mode -eq "azure" -and -not $azureReady) {
    foreach ($entry in $azureValues.GetEnumerator()) {
        if ([string]::IsNullOrWhiteSpace($entry.Value)) { $errors.Add("Missing Azure signing setting: $($entry.Key)") }
    }
} elseif ($mode -eq "pfx" -and -not $pfxReady) {
    foreach ($entry in $pfxValues.GetEnumerator()) {
        if ([string]::IsNullOrWhiteSpace($entry.Value)) { $errors.Add("Missing PFX signing setting: $($entry.Key)") }
    }
} elseif ($mode -eq "auto" -and -not ($azureReady -or $pfxReady)) {
    $errors.Add("WINDOWS_SIGNING_MODE=auto requires a complete Azure Artifact Signing or PFX configuration")
} elseif ($mode -eq "none") {
    $warnings.Add("Windows Authenticode signing is disabled; Windows/SmartScreen may warn users about an unknown or unrecognized publisher")
}

$signingSummary = if ($mode -eq "none") {
    "disabled (unsigned release allowed)"
} elseif ($azureReady) {
    "Azure ready"
} elseif ($pfxReady) {
    "PFX ready"
} else {
    "configured mode is incomplete"
}

Write-Host "Release readiness summary"
Write-Host "  Architecture:    native client -> VPS Core"
Write-Host "  OAuth settings:  configured on VPS, not embedded in Windows"
Write-Host "  Windows signing: $signingSummary"

foreach ($warning in $warnings) {
    Write-Warning $warning
}

if ($errors.Count -gt 0) {
    Write-Host ""
    Write-Host "Release readiness failed:" -ForegroundColor Red
    foreach ($item in $errors) {
        Write-Host "  - $item" -ForegroundColor Red
    }
    exit 1
}

Write-Host "Release readiness passed." -ForegroundColor Green
