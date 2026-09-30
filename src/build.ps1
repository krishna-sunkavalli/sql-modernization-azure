<#
  build.ps1 — assembles the published pages from one source.

    /                    redirect to the cost estimator
    /cost-estimator/     the core-based calculator, with list prices inlined
    /deployment-options/ the offering guide, static, no application JavaScript

  Both pages are self-contained: nothing is fetched at runtime.
#>

param(
  [string]$Root   = (Split-Path $PSScriptRoot -Parent),
  [string]$Output = $null
)

$ErrorActionPreference = 'Stop'
$build = $PSScriptRoot
if (-not $Output) { $Output = Join-Path $Root 'cost-estimator\index.html' }

$template = Get-Content (Join-Path $build 'app.template.html') -Raw -Encoding UTF8
$prices = Get-Content (Join-Path $build 'calculator-prices.json') -Raw -Encoding UTF8
$js = Get-Content (Join-Path $build 'calculator.js') -Raw -Encoding UTF8
$calculator = Get-Content (Join-Path $build 'calculator.template.html') -Raw -Encoding UTF8
$sharedHead = [regex]::Match($template, '(?s)<head>(.*?)</head>').Groups[1].Value
if (-not $sharedHead) { throw 'Shared theme head not found.' }
$sharedHead = [regex]::Replace($sharedHead, '<title>.*?</title>', '<title>SQL Modernization on Azure - Cost Estimator</title>')
$sharedHead = [regex]::Replace($sharedHead, '<meta name="description"[^>]*>', '<meta name="description" content="Compare SQL Standard and Enterprise core costs on-premises and on Azure using explicit planning assumptions.">')
$calculator = $calculator.Replace('<!--SHARED_HEAD-->', $sharedHead)

# Inject the price snapshot into the placeholder in part 1.
$pattern = '/\*__PRICES__\*/\{\}/\*__END_PRICES__\*/'
if ($js -notmatch $pattern) { throw 'Price placeholder not found in calculator.js' }
$js = [regex]::Replace($js, $pattern, { param($m) $prices }, 1)

# Sanity: the bundle must not LOAD anything external at runtime. Navigation links
# are fine — an <a href> to documentation costs the user nothing until they click
# it. What matters is that no script, stylesheet, image or frame is fetched.
$violations = @()
if ($js -match '(?<![\w.])fetch\s*\(')                    { $violations += 'fetch()' }
if ($js -match 'XMLHttpRequest')                          { $violations += 'XMLHttpRequest' }
if ($js -match 'localStorage|sessionStorage|indexedDB')   { $violations += 'browser storage' }
if ($template -match '<script[^>]+src\s*=\s*["'']?(?:https?:)?//') { $violations += 'external <script src>' }
if ($template -match '<link[^>]+href\s*=\s*["'']?(?:https?:)?//')   { $violations += 'external <link>' }
if ($template -match '<(img|iframe|video|audio|source|embed)[^>]+src\s*=\s*["'']?(?:https?:)?//') { $violations += 'external media' }
if ($violations.Count) {
  throw "Bundle is not self-contained — found: $($violations -join ', ')"
}

# .Replace() is a literal string swap — unlike -replace it will not reinterpret
# $ sequences inside the JavaScript payload.
$html = $calculator.Replace('<!--APP_SCRIPT-->', "<script>`n$js`n</script>")

$outDir = Split-Path $Output -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
Set-Content -Path $Output -Value $html -Encoding UTF8
$kb = [math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Host "Built $Output ($kb KB)" -ForegroundColor Green

<#
  The offering guide, published at /deployment-options/.

  Derived from these sources rather than maintained separately: the theme
  variables are lifted straight out of app.template.html and the content comes
  from guide.partial.html, so the guide cannot drift from the product it links
  to. It carries no application JavaScript — the guide is static content and
  needs none.
#>
$styleMatch = [regex]::Match($template, '(?s)<style>(.*?)</style>')
if (-not $styleMatch.Success) { throw 'Could not extract <style> block for the guide' }
$css = $styleMatch.Groups[1].Value

$guidePartial = Join-Path $build 'guide.partial.html'
if (-not (Test-Path $guidePartial)) { throw "Missing guide partial: $guidePartial" }
$guideBody = Get-Content $guidePartial -Raw -Encoding UTF8

# The partial's closing call to action is a button; as a page it becomes a link.
# The two pages are siblings, so the link climbs out and back down.
$guideBody = [regex]::Replace(
  $guideBody,
  '<button class="primary" id="btnGuideBack">[^<]*</button>',
  '<a class="btn primary" href="../cost-estimator/">Cost estimator &rarr;</a>')

$headMatch = [regex]::Match($template, '(?s)<head>(.*?)<style>')
$favicon   = [regex]::Match($headMatch.Groups[1].Value, '<link rel="icon"[^>]*>').Value

$guidePage = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SQL Modernization on Azure - Deployment Options</title>
<meta name="description" content="Choosing between SQL Server on Azure VM, Azure SQL Managed Instance, Azure SQL Database and serverless.">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#0078d4">
$favicon
<style>
$css
</style>
</head>
<body>
<div class="wrap">
  <header class="app">
    <div class="brand">
      <div class="mark">SQL</div>
      <div>
        <h1>SQL Modernization on Azure</h1>
        <div class="sub">Deployment Options &middot; which option fits, and why</div>
      </div>
    </div>
    <div class="spacer"></div>
    <a class="btn primary" href="../cost-estimator/">Cost estimator</a>
  </header>
  <section>
$guideBody
  </section>
</div>
</body>
</html>
"@

$guideDir = Join-Path $Root 'deployment-options'
if (-not (Test-Path $guideDir)) { New-Item -ItemType Directory -Path $guideDir -Force | Out-Null }
$guideOut = Join-Path $guideDir 'index.html'
Set-Content -Path $guideOut -Value $guidePage -Encoding UTF8
$gkb = [math]::Round((Get-Item $guideOut).Length / 1KB, 1)
Write-Host "Built $guideOut ($gkb KB)" -ForegroundColor Green

# Both pages are named, so the root is a redirect rather than a page. The
# estimator is the usual entry point, so that is where a bare link lands.
# Written as a meta refresh with a canonical link, because GitHub Pages serves
# static files and cannot issue a real redirect.
Set-Content -Path (Join-Path $Root 'index.html') -Encoding UTF8 -Value @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SQL Modernization on Azure</title>
<link rel="canonical" href="cost-estimator/">
<meta http-equiv="refresh" content="0; url=cost-estimator/">
</head>
<body><p>SQL Modernization on Azure:
<a href="cost-estimator/">Cost Estimator</a> &middot;
<a href="deployment-options/">Deployment Options</a></p></body>
</html>
"@
Write-Host "Built $Root\index.html (redirect to cost-estimator)" -ForegroundColor DarkGray
