<#
make-pdfs.ps1

Turns the walk-list HTML into PDF, because that is what a print shop takes.

Staples and the like accept PDF; their upload forms mostly will not take .html
at all. And if a clerk opens the HTML in a browser instead, the print dialog
brings its own margins, scale and URL/page-number headers -- which repaginates
everything and can split a household across a page break, which is the one
layout rule these sheets have.

Headless Chrome is used rather than "print to PDF" by hand so the output is
identical every time and nobody has to remember the dialog settings. The page
size and 10mm margins come from the @page rule in the HTML itself.

Run it after build-sheets.ts:
  powershell -File tools/walklist/make-pdfs.ps1
#>
param(
    [string]$Dir = "C:\DRO\CanvassApp\walklists"
)

$chrome = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { throw "No Chrome or Edge found - cannot render PDF." }
Write-Output "rendering with $(Split-Path $chrome -Leaf)"

# Its own profile directory. Without one, a Chrome already running as the
# user owns the default profile and the headless call exits without writing.
$profile = Join-Path $env:TEMP "walklist_pdf_profile"

$made = 0
foreach ($html in Get-ChildItem -Path $Dir -Filter "*.html" | Where-Object { $_.Name -ne "index.html" }) {
    $pdf = Join-Path $Dir ($html.BaseName + ".pdf")
    if (Test-Path $pdf) { Remove-Item $pdf -Force }
    $uri = "file:///" + ($html.FullName -replace '\\', '/')

    & $chrome --headless --disable-gpu --no-sandbox --user-data-dir="$profile" `
        --print-to-pdf="$pdf" --print-to-pdf-no-header $uri 2>$null | Out-Null

    if (Test-Path $pdf) {
        $made++
        Write-Output ("  {0,-18} {1,6:N0} KB" -f $html.Name, ((Get-Item $pdf).Length / 1KB))
    } else {
        Write-Output "  FAILED: $($html.Name)"
    }
}
Write-Output ""
Write-Output "$made PDF(s) in $Dir"
Write-Output "Take all-turfs.pdf to the print shop; the turf-NN.pdf files are for emailing one packet to one volunteer."
