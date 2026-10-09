param(
  [string]$InstallerPath = $env:AXTERM_NSIS_PATH
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'The NSIS installation gate requires Windows.'
}

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $installers = @(Get-ChildItem -LiteralPath 'release' -Filter '*.exe' -File |
    Where-Object { $_.Name -notlike 'Uninstall*' })
  if ($installers.Count -ne 1) {
    throw 'Expected exactly one NSIS installer in release/*.exe.'
  }
  $InstallerPath = $installers[0].FullName
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$sidecarPath = if ([string]::IsNullOrWhiteSpace($env:AXTERM_PACKAGED_SIDECAR)) {
  Join-Path ([IO.Path]::GetDirectoryName($installer)) 'AXTERM_PACKAGED_ARTIFACTS.windows-x64.spdx.json'
} else {
  $env:AXTERM_PACKAGED_SIDECAR
}
if (-not (Test-Path -LiteralPath $sidecarPath -PathType Leaf)) {
  throw "Packaged SPDX sidecar does not exist: $sidecarPath"
}
$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  [IO.Path]::GetTempPath()
} else {
  $env:RUNNER_TEMP
}
$temporaryRoot = [IO.Path]::GetFullPath($temporaryRoot).TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
)
$installDirectory = [IO.Path]::GetFullPath(
  (Join-Path $temporaryRoot "axterm-nsis-install-$([Guid]::NewGuid().ToString('N'))")
)
$protocolRegistryRoot = 'Registry::HKEY_CURRENT_USER\Software\Classes'
$requiredUrlSchemes = @('axterm')
$requiredPrefix = "$temporaryRoot$([IO.Path]::DirectorySeparatorChar)"
if (-not $installDirectory.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing unsafe NSIS installation directory: $installDirectory"
}
if (Test-Path -LiteralPath $installDirectory) {
  throw "Refusing to overwrite an existing installation directory: $installDirectory"
}
foreach ($scheme in $requiredUrlSchemes) {
  $userRegistration = Join-Path $protocolRegistryRoot $scheme
  $mergedRegistration = "Registry::HKEY_CLASSES_ROOT\$scheme"
  if ((Test-Path -LiteralPath $userRegistration) -or (Test-Path -LiteralPath $mergedRegistration)) {
    throw "Refusing to overwrite an existing ${scheme}:// protocol registration. Run this installation gate in a clean Windows account."
  }
}

$previousPackagedApp = $env:AXTERM_PACKAGED_APP
$uninstaller = $null
$application = $null

function Assert-InstalledUrlProtocol([string]$Scheme, [string]$ApplicationPath) {
  $schemeKeyPath = Join-Path $protocolRegistryRoot $Scheme
  if (-not (Test-Path -LiteralPath $schemeKeyPath)) {
    throw "Installed Axterm did not register ${Scheme}:// in the current user's protocol classes."
  }
  $schemeKey = Get-Item -LiteralPath $schemeKeyPath
  if ($schemeKey.GetValueNames() -notcontains 'URL Protocol') {
    throw "The ${Scheme}:// registry class is missing its URL Protocol marker."
  }
  $openCommandPath = Join-Path $schemeKeyPath 'shell\open\command'
  if (-not (Test-Path -LiteralPath $openCommandPath)) {
    throw "The ${Scheme}:// registry class is missing its open command."
  }
  $openCommand = [string](Get-Item -LiteralPath $openCommandPath).GetValue('')
  if (-not $openCommand.Contains($ApplicationPath, [StringComparison]::OrdinalIgnoreCase) -or
      $openCommand -notmatch '%1') {
    throw "The ${Scheme}:// open command does not target the installed Axterm executable with a URL argument."
  }
}

function Remove-TestUrlProtocol([string]$Scheme, [string]$ApplicationPath) {
  $schemeKeyPath = Join-Path $protocolRegistryRoot $Scheme
  $openCommandPath = Join-Path $schemeKeyPath 'shell\open\command'
  if (-not (Test-Path -LiteralPath $openCommandPath)) { return }
  $openCommand = [string](Get-Item -LiteralPath $openCommandPath).GetValue('')
  if ($openCommand.Contains($ApplicationPath, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $schemeKeyPath -Recurse -Force
  }
}

try {
  $installation = Start-Process -FilePath $installer -ArgumentList @(
    '/S',
    "/D=$installDirectory"
  ) -Wait -PassThru
  if ($installation.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installation.ExitCode)."
  }

  $application = Join-Path $installDirectory 'Axterm.exe'
  if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
    throw "Installed Axterm executable is missing: $application"
  }
  $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall*.exe' -File)
  if ($uninstallers.Count -ne 1) {
    throw 'Installed NSIS application must contain exactly one uninstaller.'
  }
  $uninstaller = $uninstallers[0].FullName

  $expectedVersion = (Get-Content -LiteralPath 'apps/desktop/package.json' -Raw |
    ConvertFrom-Json).version
  $binaryVersion = (& $application '--version' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $binaryVersion.Contains($expectedVersion)) {
    throw "Installed binary version '$binaryVersion' does not match '$expectedVersion'."
  }

  $installedResources = Join-Path $installDirectory 'resources'
  & bun run sbom:packaged:check -- $installedResources --platform windows-x64 --sidecar $sidecarPath
  if ($LASTEXITCODE -ne 0) {
    throw "Installed NSIS SPDX comparison exited with code $LASTEXITCODE."
  }
  & bun run release:updater-feed:package-check -- $installedResources
  if ($LASTEXITCODE -ne 0) {
    throw "Installed NSIS update-feed comparison exited with code $LASTEXITCODE."
  }

  $env:AXTERM_PACKAGED_APP = $installDirectory
  & bun run test:packaged
  if ($LASTEXITCODE -ne 0) {
    throw "Installed NSIS packaged journey exited with code $LASTEXITCODE."
  }

  foreach ($scheme in $requiredUrlSchemes) {
    Assert-InstalledUrlProtocol -Scheme $scheme -ApplicationPath $application
  }
} finally {
  $env:AXTERM_PACKAGED_APP = $previousPackagedApp
  if ($null -ne $application) {
    foreach ($scheme in $requiredUrlSchemes) {
      Remove-TestUrlProtocol -Scheme $scheme -ApplicationPath $application
    }
  }
  if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    $uninstallation = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($uninstallation.ExitCode -ne 0) {
      Write-Warning "NSIS uninstaller exited with code $($uninstallation.ExitCode)."
    }
  }
  if (Test-Path -LiteralPath $installDirectory) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
  }
}
