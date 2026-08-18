Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$releaseDir = Join-Path $PSScriptRoot "../src-tauri/target/release"
$bundleDir = Join-Path $releaseDir "bundle/nsis"

$appExecutables = @(Get-ChildItem -Path $releaseDir -Filter "*.exe" -File -ErrorAction SilentlyContinue)
$installers = @(Get-ChildItem -Path $bundleDir -Filter "*.exe" -File -ErrorAction SilentlyContinue)
$targets = @($appExecutables + $installers | Sort-Object FullName -Unique)

if ($appExecutables.Count -eq 0) {
    throw "No built application executable was found for Authenticode verification"
}
if ($installers.Count -eq 0) {
    throw "No NSIS installer was found for Authenticode verification"
}

foreach ($target in $targets) {
    $signature = Get-AuthenticodeSignature -FilePath $target.FullName
    if ($signature.Status -ne "Valid") {
        throw "Invalid Authenticode signature for $($target.FullName): $($signature.Status) $($signature.StatusMessage)"
    }
    if (-not $signature.SignerCertificate) {
        throw "No signer certificate was returned for $($target.FullName)"
    }
    Write-Host "Verified Authenticode: $($target.Name) -> $($signature.SignerCertificate.Subject)"
}
