$utf8bom = New-Object System.Text.UTF8Encoding($true)
$files = @(
    "$PSScriptRoot\install.ps1",
    "$PSScriptRoot\install.sh"
)
foreach ($f in $files) {
    if (Test-Path $f) {
        $content = Get-Content $f -Raw -Encoding UTF8
        [System.IO.File]::WriteAllText($f, $content, $utf8bom)
        Write-Host "BOM added: $f"
    } else {
        Write-Host "NOT FOUND: $f"
    }
}
