# Render console pages with headless Chrome and save PNGs.
#
# WHY THIS EXISTS. There is no JavaScript engine on this machine and the browser
# tooling prompts for permission on every use, so for months the only way to know
# whether a visual change worked was to ask the owner to look. That made design
# iteration cost a round trip each time, and it is how a page shipped once with a
# deleted function: every static check passed while the script threw on first
# render.
#
# Chrome is already installed. Headless screenshot mode is a plain subprocess
# that writes a file — no install, no prompt, no extension. It runs the page's
# real JavaScript against the real API, so what comes out is what the router
# actually serves.
#
#     pwsh -File shots.ps1                      # all pages, current theme
#     pwsh -File shots.ps1 -Pages dashboard     # one page
#     pwsh -File shots.ps1 -Theme light -W 420 -H 1800   # phone width, light
#
# A separate --user-data-dir is not optional: Chrome refuses to start headless
# against a profile an interactive window already holds, and the failure is a
# silent missing file rather than an error.

param(
  [string]$Router = '192.168.8.1',
  [string[]]$Pages = @('dashboard','vpn','repeater','tethering','settings'),
  [ValidateSet('dark','light','system')][string]$Theme = 'system',
  [int]$W = 1400,
  [int]$H = 2400,
  [string]$Tag = 'now',
  [string]$Out = "$PSScriptRoot\.shots"
)

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { Write-Error 'Chrome not found'; exit 1 }
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out | Out-Null }

# preferredColorScheme: 1 = light, 2 = dark. Omitted entirely for 'system' so the
# page follows the host, which is the state most viewers are actually in.
$scheme = switch ($Theme) { 'light' { 1 } 'dark' { 2 } default { $null } }

foreach ($p in $Pages) {
  $file = Join-Path $Out "$Tag-$p-$Theme.png"
  if (Test-Path $file) { Remove-Item $file }
  # EVERY PATH ARGUMENT IS QUOTED. This repo lives under "OpenWrt project", and
  # Start-Process -ArgumentList splits an unquoted array element on its spaces:
  # Chrome then reads the tail of the path as a second URL and dies with
  # "Multiple targets are not supported in headless mode" — a message that says
  # nothing about quoting and sent the first attempt looking at the wrong flags.
  $a = @(
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu',
    '--hide-scrollbars','--force-color-profile=srgb',
    "`"--user-data-dir=$Out\profile`"",
    '--virtual-time-budget=9000',
    "--window-size=$W,$H",
    "`"--screenshot=$file`""
  )
  if ($null -ne $scheme) { $a += "--blink-settings=preferredColorScheme=$scheme" }
  $a += "http://$Router/$p/"

  Start-Process -FilePath $chrome -ArgumentList $a -NoNewWindow -Wait -ErrorAction SilentlyContinue 2>$null | Out-Null
  if (Test-Path $file) {
    '{0,-11} {1,8:N0} bytes  {2}' -f $p, (Get-Item $file).Length, $file
  } else {
    '{0,-11} FAILED' -f $p
  }
}
