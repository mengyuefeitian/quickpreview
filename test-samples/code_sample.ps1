# QuickPreview 代码文件预览测试
$ErrorActionPreference = 'Stop'

Write-Host "QuickPreview script test"

function Get-SampleInfo {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path
    return [PSCustomObject]@{
        Name     = $item.Name
        Length   = $item.Length
        Modified = $item.LastWriteTime
    }
}

Get-ChildItem -Path . -Filter *.py | Select-Object -First 5 | ForEach-Object {
    Get-SampleInfo -Path $_.FullName
}
