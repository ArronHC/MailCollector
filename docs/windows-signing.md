# Windows Authenticode signing

Mail Collector release builds must be Authenticode-signed before GitHub Release publishing. The release workflow is intentionally fail-closed: if no trusted signing identity is configured, it stops before building/publishing a Windows installer.

This is separate from Tauri updater signatures. Authenticode identifies the Windows publisher of the application/installer; updater signatures protect update metadata and payload integrity.

## Preferred option when eligible: Azure Artifact Signing

Use Azure Artifact Signing when the publisher is eligible for a Public Trust certificate profile and the required Azure subscription is available. Microsoft applies regional, subscription, identity-validation, and RBAC eligibility requirements to Public Trust signing, so verify the current Artifact Signing prerequisites before choosing this path. If Public Trust onboarding is unavailable for the publisher, use another publicly trusted code-signing provider rather than Private Trust for a public Windows download.

Configure these GitHub Actions values:

Secrets:

- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TENANT_ID`

Repository variables:

- `WINDOWS_SIGNING_MODE=azure`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`

The workflow installs `artifact-signing-cli` on the ephemeral Windows runner and gives Tauri a temporary `signCommand`. No signing key is stored in this repository.

## Alternative: trusted PFX certificate

Use this only when your certificate/key provider permits an automated exportable PFX workflow. Modern OV/EV certificate issuance often uses hardware or cloud-backed private keys; follow the issuer's current instructions rather than assuming a PFX can be exported.

Secrets:

- `WINDOWS_CERTIFICATE`: base64-encoded PFX bytes
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX password

Repository variables:

- `WINDOWS_SIGNING_MODE=pfx`
- `WINDOWS_TIMESTAMP_URL`: trusted timestamp service URL
- `WINDOWS_TIMESTAMP_TSP=true` for RFC 3161 timestamping; set `false` only when the certificate provider explicitly requires legacy Authenticode timestamping

The release job writes the PFX only into the ephemeral runner, imports it into `Cert:\CurrentUser\My`, removes the temporary PFX file, and asks Tauri to sign with the imported certificate thumbprint using SHA-256.

If a chosen CA/provider only offers hardware-backed or cloud-backed keys and cannot expose an exportable PFX, add that provider's supported signing client as a Tauri `signCommand` integration instead of copying private-key material into GitHub Actions.

## Auto mode

`WINDOWS_SIGNING_MODE=auto` first uses Azure Artifact Signing when all Azure settings are present, otherwise uses PFX when all PFX settings are present. Explicit `azure` or `pfx` is recommended for production so a partial credential migration cannot silently choose the other path.

## Release verification

After the Tauri NSIS build, `scripts/verify-windows-signing.ps1` calls `Get-AuthenticodeSignature` for the built application executable and installer. Publishing is blocked unless every checked executable reports a valid signature and a signer certificate.

Keep all private keys, certificate passwords, Azure client secrets, and tenant credentials in GitHub Actions Secrets. Do not commit them to source, Tauri resources, build artifacts, or documentation.

## SmartScreen expectations

Authenticode fixes the current "unknown publisher" problem and lets Windows associate binaries with a verified publisher. It does not guarantee that a brand-new certificate or binary immediately has enough Microsoft Defender SmartScreen reputation to suppress every warning. Reputation normally accumulates over signed releases and downloads. Microsoft Store distribution is a separate option if a consistently warning-free first-install path is required.
