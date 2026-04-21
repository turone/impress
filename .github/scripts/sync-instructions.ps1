<#
.SYNOPSIS
  Syncs branch-specific Copilot instruction files from the CopilotInstructions
  branch into the current working directory without staging them.

.DESCRIPTION
  Fetches the latest CopilotInstructions branch from origin, extracts
  .github/instructions/ files into the working tree, then unstages them
  so they remain untracked. Also ensures .git/info/exclude hides them
  from git status.

.EXAMPLE
  .github/scripts/sync-instructions.ps1
#>

$ErrorActionPreference = 'Stop'
$branch = 'CopilotInstructions'
$remote = 'origin'
$instructionsPath = '.github/instructions/'
$excludeFile = '.git/info/exclude'
$excludePattern = '.github/instructions/*.instructions.md'

# Fetch latest
Write-Host "Fetching $remote/$branch..."
git fetch $remote $branch

# Extract instruction files into working directory
Write-Host "Extracting instruction files..."
git checkout "$remote/$branch" -- $instructionsPath

# Unstage so they stay untracked
git reset HEAD -- $instructionsPath 2>$null

# Ensure .git/info/exclude has the pattern
if (Test-Path $excludeFile) {
    $content = Get-Content $excludeFile -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -notmatch [regex]::Escape($excludePattern)) {
        Add-Content $excludeFile "`n$excludePattern"
        Write-Host "Added '$excludePattern' to $excludeFile"
    }
} else {
    New-Item -Path $excludeFile -ItemType File -Force | Out-Null
    Set-Content $excludeFile $excludePattern
    Write-Host "Created $excludeFile with '$excludePattern'"
}

Write-Host 'Done. Instruction files are present but untracked.'
