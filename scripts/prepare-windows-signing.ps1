Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-Value([string]$Name, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Missing required Windows signing setting: $Name"
    }
}

function Write-SigningConfig([hashtable]$WindowsConfig) {
    $configPath = Join-Path $PSScriptRoot "../src-tauri/tauri.signing.conf.json"
    $config = @{
        bundle = @{
            windows = $WindowsConfig
        }
    }
    $config | ConvertTo-Json -Depth 8 | Set-Content -Path $configPath -Encoding utf8
    Write-Host "Prepared Tauri signing config: $configPath"
}

function Prepare-PfxSigning {
    Require-Value "WINDOWS_CERTIFICATE" $env:WINDOWS_CERTIFICATE
    Require-Value "WINDOWS_CERTIFICATE_PASSWORD" $env:WINDOWS_CERTIFICATE_PASSWORD
    Require-Value "WINDOWS_TIMESTAMP_URL" $env:WINDOWS_TIMESTAMP_URL

    $certificateText = $env:WINDOWS_CERTIFICATE
    $certificateText = $certificateText -replace "-----BEGIN [^-]+-----", ""
    $certificateText = $certificateText -replace "-----END [^-]+-----", ""
    $certificateText = $certificateText -replace "\s", ""
    try {
        $certificateBytes = [Convert]::FromBase64String($certificateText)
    } catch {
        throw "WINDOWS_CERTIFICATE is not valid base64-encoded PFX data"
    }

    $certificatePath = Join-Path $env:RUNNER_TEMP "mail-collector-signing.pfx"
    [IO.File]::WriteAllBytes($certificatePath, $certificateBytes)
    try {
        $securePassword = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -Force -AsPlainText
        $imported = @(Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\My" -Password $securePassword)
        $certificate = $imported | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
        if (-not $certificate) {
            throw "The imported PFX does not contain an accessible code-signing private key"
        }
        if ($certificate.NotAfter -le (Get-Date)) {
            throw "The Windows code-signing certificate is expired"
        }

        $useTsp = $true
        if ($env:WINDOWS_TIMESTAMP_TSP -match "^(0|false|no)$") {
            $useTsp = $false
        }
        Write-SigningConfig @{
            certificateThumbprint = $certificate.Thumbprint
            digestAlgorithm = "sha256"
            timestampUrl = $env:WINDOWS_TIMESTAMP_URL
            tsp = $useTsp
        }
        Write-Host "Configured PFX Authenticode signing for $($certificate.Subject)"
    } finally {
        Remove-Item -Path $certificatePath -Force -ErrorAction SilentlyContinue
    }
}

function Prepare-AzureArtifactSigning {
    Require-Value "AZURE_CLIENT_ID" $env:AZURE_CLIENT_ID
    Require-Value "AZURE_CLIENT_SECRET" $env:AZURE_CLIENT_SECRET
    Require-Value "AZURE_TENANT_ID" $env:AZURE_TENANT_ID
    Require-Value "AZURE_ARTIFACT_SIGNING_ENDPOINT" $env:AZURE_ARTIFACT_SIGNING_ENDPOINT
    Require-Value "AZURE_ARTIFACT_SIGNING_ACCOUNT" $env:AZURE_ARTIFACT_SIGNING_ACCOUNT
    Require-Value "AZURE_ARTIFACT_SIGNING_PROFILE" $env:AZURE_ARTIFACT_SIGNING_PROFILE

    cargo install artifact-signing-cli --locked
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install artifact-signing-cli"
    }

    $endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT.Replace('"', '')
    $account = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT.Replace('"', '')
    $profile = $env:AZURE_ARTIFACT_SIGNING_PROFILE.Replace('"', '')
    $signCommand = "artifact-signing-cli -e `"$endpoint`" -a `"$account`" -c `"$profile`" -d `"Mail Collector`" %1"
    Write-SigningConfig @{
        signCommand = $signCommand
    }
    Write-Host "Configured Azure Artifact Signing"
}

$mode = ($env:WINDOWS_SIGNING_MODE ?? "auto").Trim().ToLowerInvariant()
if ($mode -notin @("auto", "azure", "pfx")) {
    throw "WINDOWS_SIGNING_MODE must be auto, azure, or pfx"
}

$azureReady = -not [string]::IsNullOrWhiteSpace($env:AZURE_CLIENT_ID) -and
              -not [string]::IsNullOrWhiteSpace($env:AZURE_CLIENT_SECRET) -and
              -not [string]::IsNullOrWhiteSpace($env:AZURE_TENANT_ID) -and
              -not [string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_ENDPOINT) -and
              -not [string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_ACCOUNT) -and
              -not [string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PROFILE)
$pfxReady = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE) -and
            -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD) -and
            -not [string]::IsNullOrWhiteSpace($env:WINDOWS_TIMESTAMP_URL)

if ($mode -eq "azure" -or ($mode -eq "auto" -and $azureReady)) {
    Prepare-AzureArtifactSigning
} elseif ($mode -eq "pfx" -or ($mode -eq "auto" -and $pfxReady)) {
    Prepare-PfxSigning
} else {
    throw "Windows release signing is not configured. Configure Azure Artifact Signing or a trusted PFX certificate before publishing."
}
