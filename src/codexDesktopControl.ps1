param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$typeDefinition = @'
using System;
using System.Runtime.InteropServices;
public static class MatDesktopInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@
Add-Type -TypeDefinition $typeDefinition -PassThru | Out-Null

$composerName = [string]::Concat([char]0x5411, " Agent ", [char]0x53D1, [char]0x9001, [char]0x6D88, [char]0x606F)
$remoteComposerName = [string]::Concat([char]0x9065, [char]0x63A7, " Codex Desktop ", [char]0x53D1, [char]0x9001, [char]0x6D88, [char]0x606F)
$desktopRemoteChipName = [string]::Concat("Desktop ", [char]0x9065, [char]0x63A7)
$stopNameZh = -join @([char]0x505C, [char]0x6B62)
$sendNameZh = -join @([char]0x53D1, [char]0x9001)
$fallbackComposerNames = @($composerName, "Ask Codex", "Message Codex", "Send a message to Agent")
$fallbackSendNames = @($sendNameZh, "Send")
$ownRemoteUiNames = @($remoteComposerName, $desktopRemoteChipName)
$placeholderValues = @($composerName, $remoteComposerName, "Ask Codex", "Message Codex", "Send a message to Codex", "Send a message to Agent")
$remoteHostHints = @("trycloudflare.com", "127.0.0.1:8787", "localhost:8787", "192.168.3.61:8787")

function To-RectObject($rect) {
  if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or [double]::IsInfinity($rect.Width) -or [double]::IsInfinity($rect.Height)) {
    return [ordered]@{
      x = 0
      y = 0
      width = 0
      height = 0
      text = $rect.ToString()
    }
  }

  return [ordered]@{
    x = [int]$rect.X
    y = [int]$rect.Y
    width = [int]$rect.Width
    height = [int]$rect.Height
    text = $rect.ToString()
  }
}

function Get-Pattern($element, $pattern) {
  $obj = $null
  if ($null -eq $element) { return $null }
  if ($element.TryGetCurrentPattern($pattern, [ref]$obj)) { return $obj }
  return $null
}

function Read-Value($element) {
  $pattern = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $pattern) { return "" }
  return [string]$pattern.Current.Value
}

function Normalize-InputValue($element, [string]$value) {
  $trimmed = $value.Trim()
  if ($trimmed -eq "") { return "" }

  $name = ""
  if ($null -ne $element) { $name = [string]$element.Current.Name }
  if ($name.Trim() -eq $trimmed) { return "" }

  foreach ($placeholder in $placeholderValues) {
    if ($placeholder.Trim() -eq $trimmed) { return "" }
  }

  return $value
}

function Read-NormalizedValue($element) {
  return Normalize-InputValue $element (Read-Value $element)
}

function Set-Value($element, [string]$value) {
  $pattern = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $pattern) { return $false }
  $pattern.SetValue($value)
  return $true
}

function Click-RectCenter($rect) {
  $x = [int]($rect.X + ($rect.Width / 2))
  $y = [int]($rect.Y + ($rect.Height / 2))
  [void][MatDesktopInput]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [MatDesktopInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [MatDesktopInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return "$x,$y"
}

function Save-Clipboard() {
  try {
    return [ordered]@{
      hadData = $true
      data = [System.Windows.Forms.Clipboard]::GetDataObject()
    }
  } catch {
    return [ordered]@{
      hadData = $false
      data = $null
    }
  }
}

function Restore-Clipboard($saved) {
  try {
    if ($saved.hadData -and $null -ne $saved.data) {
      [System.Windows.Forms.Clipboard]::SetDataObject($saved.data, $true)
    } else {
      [System.Windows.Forms.Clipboard]::Clear()
    }
  } catch {
    # Clipboard restore is best effort.
  }
}

function Test-IsOwnRemoteElement($element) {
  if ($null -eq $element) { return $false }
  $name = [string]$element.Current.Name
  foreach ($ownName in $ownRemoteUiNames) {
    if ($name -eq $ownName) { return $true }
  }
  return $false
}

function Test-IsStopName([string]$name) {
  return $name -eq $stopNameZh -or $name -eq "Stop"
}

function Test-IsComposerSendCandidate($element) {
  if ($null -eq $element) { return $false }
  $bounds = $element.Current.BoundingRectangle
  $name = ([string]$element.Current.Name).Trim()
  if ($bounds.Width -lt 25 -or $bounds.Height -lt 25) { return $false }
  if ($bounds.Width -gt 52 -or $bounds.Height -gt 52) { return $false }
  if ($name -match "^(自定义|任务设置|设置|思考|强度|模型|模式|完全访问|默认|Custom|Settings|Thinking|Reasoning|Model|Mode|Access|Default)$") { return $false }
  return $true
}

function Test-OwnRemotePageVisible($window) {
  $editCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )
  $edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
  for ($i = 0; $i -lt $edits.Count; $i++) {
    $element = $edits.Item($i)
    if (Test-IsOwnRemoteElement $element) { return $true }
    $value = Read-Value $element
    foreach ($hint in $remoteHostHints) {
      if ($value -like "*$hint*") { return $true }
    }
  }

  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  for ($i = 0; $i -lt $buttons.Count; $i++) {
    if (Test-IsOwnRemoteElement $buttons.Item($i)) { return $true }
  }

  return $false
}

function Find-DescendantByControlTypeAndName($root, $controlType, $names) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $controlType
  )
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    foreach ($name in $names) {
      if ($element.Current.Name -eq $name) { return $element }
    }
  }
  return $null
}

function Find-BottomEdit($window) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $windowBounds = $window.Current.BoundingRectangle
  $candidates = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.Width -lt 180 -or $bounds.Height -lt 24) { continue }
    if ($bounds.Y -lt ($windowBounds.Y + ($windowBounds.Height * 0.55))) { continue }
    $candidates += [ordered]@{
      element = $element
      score = ($bounds.Y * 10000) + $bounds.Width
    }
  }

  if ($candidates.Count -eq 0) { return $null }
  return ($candidates | Sort-Object score -Descending | Select-Object -First 1).element
}

function Find-BottomSendButton($window, $input) {
  $named = Find-DescendantByControlTypeAndName $window ([System.Windows.Automation.ControlType]::Button) $fallbackSendNames
  if ($null -ne $named) { return $named }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $inputBounds = $input.Current.BoundingRectangle
  $candidates = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if (-not (Test-IsComposerSendCandidate $element)) { continue }
    $verticalDistance = [Math]::Abs(($bounds.Y + ($bounds.Height / 2)) - ($inputBounds.Y + ($inputBounds.Height / 2)))
    if ($verticalDistance -gt 90) { continue }
    if ($bounds.X -lt $inputBounds.X) { continue }
    $candidates += [ordered]@{
      element = $element
      score = $bounds.X
    }
  }

  if ($candidates.Count -eq 0) { return $null }
  return ($candidates | Sort-Object score -Descending | Select-Object -First 1).element
}

function Find-BottomActionButton($window, [string]$side) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $windowBounds = $window.Current.BoundingRectangle
  $candidates = @()
  $minXRatio = 0.45
  if ($side -eq "left") { $minXRatio = 0.25 }

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    $name = ([string]$element.Current.Name).Trim()
    if ($side -eq "right") {
      if (-not (Test-IsComposerSendCandidate $element)) { continue }
    } elseif ($bounds.Width -lt 32 -or $bounds.Height -lt 32) {
      continue
    }
    if ($bounds.Y -lt ($windowBounds.Y + ($windowBounds.Height * 0.72))) { continue }
    if ($bounds.X -lt ($windowBounds.X + ($windowBounds.Width * $minXRatio))) { continue }
    if ($side -eq "right") {
      if ($bounds.X -lt ($windowBounds.X + ($windowBounds.Width * 0.65))) { continue }
    }

    $score = $bounds.X
    if ($side -eq "left") { $score = -1 * $bounds.X }

    $candidates += [ordered]@{
      element = $element
      score = $score
    }
  }

  if ($candidates.Count -eq 0) { return $null }
  return ($candidates | Sort-Object score -Descending | Select-Object -First 1).element
}

function Find-ComposerLeftButton($window, $send) {
  if ($null -eq $send) { return $null }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $sendBounds = $send.Current.BoundingRectangle
  $sendCenterY = $sendBounds.Y + ($sendBounds.Height / 2)
  $candidates = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.Width -lt 30 -or $bounds.Height -lt 30) { continue }
    if ($bounds.X -ge $sendBounds.X) { continue }
    $verticalDistance = [Math]::Abs(($bounds.Y + ($bounds.Height / 2)) - $sendCenterY)
    if ($verticalDistance -gt 45) { continue }

    $candidates += [ordered]@{
      element = $element
      score = -1 * $bounds.X
    }
  }

  if ($candidates.Count -eq 0) { return $null }
  return ($candidates | Sort-Object score -Descending | Select-Object -First 1).element
}

function Find-SyntheticComposerBounds($window, $send) {
  if ($null -eq $send) { return $null }

  $plus = Find-ComposerLeftButton $window $send
  $sendBounds = $send.Current.BoundingRectangle
  $windowBounds = $window.Current.BoundingRectangle
  if ($null -eq $plus) {
    $x = $windowBounds.X + 60
    $right = $sendBounds.X - 10
    $width = $right - $x
    if ($width -lt 120) { return $null }
    return [System.Windows.Rect]::new($x, $sendBounds.Y, $width, $sendBounds.Height)
  }

  $plusBounds = $plus.Current.BoundingRectangle
  if ($sendBounds.X -le $plusBounds.X) { return $null }

  $x = $plusBounds.X + $plusBounds.Width + 8
  $right = $sendBounds.X - 10
  $width = $right - $x
  if ($width -lt 120) { return $null }

  $height = [Math]::Max($plusBounds.Height, $sendBounds.Height)
  $y = [Math]::Min($plusBounds.Y, $sendBounds.Y)
  return [System.Windows.Rect]::new($x, $y, $width, $height)
}

function Get-BottomButtons($window) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $windowBounds = $window.Current.BoundingRectangle
  $buttons = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if ($bounds.Y -lt ($windowBounds.Y + ($windowBounds.Height * 0.72))) { continue }
    $buttons += [ordered]@{
      name = $element.Current.Name
      enabled = $element.Current.IsEnabled
      bounds = To-RectObject $bounds
    }
  }

  return $buttons
}

function Test-RectUsable($rect) {
  if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or [double]::IsInfinity($rect.Width) -or [double]::IsInfinity($rect.Height)) {
    return $false
  }
  return $rect.Width -gt 0 -and $rect.Height -gt 0
}

function Test-RunningHintText([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  $lower = $text.ToLowerInvariant()
  $runningZh = -join @([char]0x8FD0, [char]0x884C)
  $activeZh = -join @([char]0x6B63, [char]0x5728)
  return $lower.Contains("running") -or
    $lower.Contains("loading") -or
    $lower.Contains("spinner") -or
    $lower.Contains("progress") -or
    $lower.Contains("busy") -or
    $lower.Contains("animate-spin") -or
    $lower.Contains("lucide-loader") -or
    $text.Contains($stopNameZh) -or
    $text.Contains($runningZh) -or
    $text.Contains($activeZh)
}

function Get-ElementSignature($element) {
  if ($null -eq $element) { return "" }
  $parts = @()
  try { $parts += [string]$element.Current.Name } catch {}
  try { $parts += [string]$element.Current.ClassName } catch {}
  try { $parts += [string]$element.Current.AutomationId } catch {}
  try { $parts += [string]$element.Current.HelpText } catch {}
  try { $parts += [string]$element.Current.ItemStatus } catch {}
  try { $parts += [string]$element.Current.ControlType.ProgrammaticName } catch {}
  return ($parts -join " ")
}

function Get-SidebarRunningIndicators($window) {
  if ($null -eq $window) { return @() }
  $windowBounds = $window.Current.BoundingRectangle
  if (-not (Test-RectUsable $windowBounds)) { return @() }

  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $leftLimit = $windowBounds.X + ($windowBounds.Width * 0.36)
  $topLimit = $windowBounds.Y + 120
  $bottomLimit = $windowBounds.Y + $windowBounds.Height - 40
  $results = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if (-not (Test-RectUsable $bounds)) { continue }
    if ($bounds.X -gt $leftLimit -or ($bounds.X + $bounds.Width) -lt $windowBounds.X) { continue }
    if ($bounds.Y -lt $topLimit -or $bounds.Y -gt $bottomLimit) { continue }

    $controlType = ""
    try { $controlType = [string]$element.Current.ControlType.ProgrammaticName } catch {}
    $signature = Get-ElementSignature $element
    $isProgress = $controlType -eq "ControlType.ProgressBar"
    $isSmallIndicator = $bounds.Width -le 48 -and $bounds.Height -le 48
    $hasHint = Test-RunningHintText $signature
    if (-not $isProgress -and -not ($hasHint -and $isSmallIndicator)) { continue }

    $results += [ordered]@{
      signature = $signature.Trim()
      controlType = $controlType
      x = [double]$bounds.X
      y = [double]$bounds.Y
      width = [double]$bounds.Width
      height = [double]$bounds.Height
      bounds = To-RectObject $bounds
    }
  }

  return $results
}

function Test-RowHasRunningIndicator($rowBounds, $indicators) {
  if (-not (Test-RectUsable $rowBounds)) { return $false }
  $rowRight = $rowBounds.X + $rowBounds.Width
  $rowBottom = $rowBounds.Y + $rowBounds.Height
  $rightSide = $rowBounds.X + ($rowBounds.Width * 0.55)

  foreach ($indicator in $indicators) {
    $indicatorRight = $indicator.x + $indicator.width
    $indicatorBottom = $indicator.y + $indicator.height
    $overlaps =
      $indicator.x -lt $rowRight -and
      $indicatorRight -gt $rowBounds.X -and
      $indicator.y -lt $rowBottom -and
      $indicatorBottom -gt $rowBounds.Y
    $nearRightEdge = $indicator.x -gt $rightSide
    if ($overlaps -and $nearRightEdge) { return $true }
  }

  return $false
}

function Get-DesktopSidebarConversationCandidates($window, [int]$limit = 10) {
  if ($null -eq $window) { return @() }
  $windowBounds = $window.Current.BoundingRectangle
  if (-not (Test-RectUsable $windowBounds)) { return @() }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $indicators = @(Get-SidebarRunningIndicators $window)
  $expandShowName = -join @([char]0x5C55, [char]0x5F00, [char]0x663E, [char]0x793A)
  $leftLimit = $windowBounds.X + ($windowBounds.Width * 0.36)
  $topLimit = $windowBounds.Y + 120
  $bottomLimit = $windowBounds.Y + $windowBounds.Height - 55
  $candidates = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if (-not (Test-RectUsable $bounds)) { continue }
    if ($bounds.X -gt $leftLimit -or ($bounds.X + $bounds.Width) -lt $windowBounds.X) { continue }
    if ($bounds.Y -lt $topLimit -or $bounds.Y -gt $bottomLimit) { continue }
    if ($bounds.Width -lt 150 -or $bounds.Height -lt 28 -or $bounds.Height -gt 58) { continue }

    $rawName = ([string]$element.Current.Name).Trim()
    if ([string]::IsNullOrWhiteSpace($rawName)) { continue }
    if ($rawName -eq $expandShowName) { continue }
    $className = [string]$element.Current.ClassName
    if ($className -like "*group/cwd*") { continue }

    $title = ($rawName -replace "\s+", " ").Trim()
    $candidates += [pscustomobject]@{
      element = $element
      rawName = $rawName
      title = $title
      className = $className
      running = Test-RowHasRunningIndicator $bounds $indicators
      x = [double]$bounds.X
      y = [double]$bounds.Y
      bounds = $bounds
    }
  }

  if ($candidates.Count -eq 0) { return @() }
  return @($candidates | Sort-Object @{ Expression = { $_.y } }, @{ Expression = { $_.x } } | Select-Object -First $limit)
}

function Get-DesktopSidebarProjectCandidates($window, [int]$limit = 10) {
  if ($null -eq $window) { return @() }
  $windowBounds = $window.Current.BoundingRectangle
  if (-not (Test-RectUsable $windowBounds)) { return @() }

  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem
  )
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $leftLimit = $windowBounds.X + ($windowBounds.Width * 0.36)
  $topLimit = $windowBounds.Y + 100
  $bottomLimit = $windowBounds.Y + $windowBounds.Height - 55
  $projects = @()

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if (-not (Test-RectUsable $bounds)) { continue }
    if ($bounds.X -gt $leftLimit -or ($bounds.X + $bounds.Width) -lt $windowBounds.X) { continue }
    if ($bounds.Y -lt $topLimit -or $bounds.Y -gt $bottomLimit) { continue }

    $className = [string]$element.Current.ClassName
    if ($className -notlike "*group/cwd*") { continue }
    $rawName = ([string]$element.Current.Name).Trim()
    if ([string]::IsNullOrWhiteSpace($rawName)) { continue }
    $projects += [pscustomobject]@{
      element = $element
      rawName = $rawName
      title = ($rawName -replace "\s+", " ").Trim()
      className = $className
      x = [double]$bounds.X
      y = [double]$bounds.Y
      bounds = $bounds
    }
  }

  if ($projects.Count -eq 0) { return @() }
  return @($projects | Sort-Object @{ Expression = { $_.y } }, @{ Expression = { $_.x } } | Select-Object -First $limit)
}

function Get-DesktopSidebarConversations($window, [int]$limit = 10) {
  $items = @(Get-DesktopSidebarConversationCandidates $window $limit)
  $projects = @(Get-DesktopSidebarProjectCandidates $window 20)
  $result = @()
  for ($i = 0; $i -lt $items.Count; $i++) {
    $item = $items[$i]
    $projectIndex = -1
    $projectTitle = ""
    for ($p = 0; $p -lt $projects.Count; $p++) {
      if ($projects[$p].y -le $item.y) {
        $projectIndex = $p
        $projectTitle = $projects[$p].title
      }
    }
    $result += [ordered]@{
      index = $i
      title = $item.title
      rawName = $item.rawName
      projectIndex = $projectIndex
      projectTitle = $projectTitle
      running = [bool]$item.running
      bounds = To-RectObject $item.bounds
    }
  }
  return $result
}

function Get-DesktopSidebarProjects($window, [int]$limit = 10) {
  $items = @(Get-DesktopSidebarProjectCandidates $window $limit)
  $result = @()
  for ($i = 0; $i -lt $items.Count; $i++) {
    $item = $items[$i]
    $result += [ordered]@{
      index = $i
      title = $item.title
      rawName = $item.rawName
      bounds = To-RectObject $item.bounds
    }
  }
  return $result
}

function Test-VisibleTranscriptText([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  $value = ($text -replace "\s+", " ").Trim()
  if ($value.Length -lt 2) { return $false }
  if ($value -eq $composerName -or $value -eq $remoteComposerName) { return $false }
  if ($value -match "^(Codex|AT|Agent|AGENT|System|SYSTEM|User|USER|You|You:|Agent .+|Desktop .+|http://|https://)$") { return $false }
  if ($value -match "^\d{1,2}:\d{2}(:\d{2})?$") { return $false }
  return $true
}

function Get-VisibleTranscript($window, [int]$limit = 80) {
  if ($null -eq $window) { return @() }
  $windowBounds = $window.Current.BoundingRectangle
  if (-not (Test-RectUsable $windowBounds)) { return @() }

  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $leftLimit = $windowBounds.X + ($windowBounds.Width * 0.36)
  $topLimit = $windowBounds.Y + 65
  $bottomLimit = $windowBounds.Y + ($windowBounds.Height * 0.86)
  $candidates = @()
  $allowedControlTypes = @(
    "ControlType.Text",
    "ControlType.Document",
    "ControlType.Edit",
    "ControlType.Custom"
  )

  for ($i = 0; $i -lt $items.Count; $i++) {
    $element = $items.Item($i)
    if (Test-IsOwnRemoteElement $element) { continue }
    $bounds = $element.Current.BoundingRectangle
    if (-not (Test-RectUsable $bounds)) { continue }
    if ($bounds.X -lt $leftLimit) { continue }
    if ($bounds.Y -lt $topLimit -or $bounds.Y -gt $bottomLimit) { continue }
    if ($bounds.Width -lt 20 -or $bounds.Height -lt 8) { continue }

    $controlType = ""
    try { $controlType = [string]$element.Current.ControlType.ProgrammaticName } catch {}
    if (-not ($allowedControlTypes -contains $controlType)) { continue }
    if ($controlType -eq "ControlType.Edit" -and $bounds.Y -gt ($windowBounds.Y + ($windowBounds.Height * 0.78))) { continue }

    $name = ([string]$element.Current.Name).Trim()
    $value = Read-Value $element
    $text = ""
    if (Test-VisibleTranscriptText $name) { $text = $name }
    if ([string]::IsNullOrWhiteSpace($text) -and (Test-VisibleTranscriptText $value)) { $text = $value }
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    if ($text -like "*$remoteComposerName*") { continue }

    $role = "system"
    if ($bounds.X -gt ($windowBounds.X + ($windowBounds.Width * 0.70))) { $role = "user" }
    elseif ($controlType -eq "ControlType.Button" -or $text -match "^(Tool|Command|Patch|Apply|Run|Bash|Shell|Error|Exited|Starting)") { $role = "system" }
    else { $role = "assistant" }

    $candidates += [pscustomobject]@{
      role = $role
      kind = $controlType.Replace("ControlType.", "").ToLowerInvariant()
      text = ($text -replace "\s+", " ").Trim()
      x = [double]$bounds.X
      y = [double]$bounds.Y
      width = [double]$bounds.Width
      height = [double]$bounds.Height
      bounds = $bounds
    }
  }

  $deduped = @()
  $seen = @{}
  foreach ($item in ($candidates | Sort-Object @{ Expression = { $_.y } }, @{ Expression = { $_.x } })) {
    $key = [string]::Concat($item.role, "|", $item.kind, "|", $item.text)
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $deduped += $item
  }

  $tail = @($deduped | Select-Object -Last $limit)
  $result = @()
  for ($i = 0; $i -lt $tail.Count; $i++) {
    $item = $tail[$i]
    $result += [ordered]@{
      index = $i
      role = $item.role
      kind = $item.kind
      text = $item.text
      bounds = To-RectObject $item.bounds
    }
  }
  return $result
}

function Find-CodexDesktopWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $processes = Get-Process -Name Codex -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      ($_.Path -like "*OpenAI.Codex_*" -or $_.Path -like "*\OpenAI\Codex\*")
    } |
    Sort-Object StartTime

  foreach ($process in $processes) {
    $handle = [IntPtr]::new([int64]$process.MainWindowHandle)
    $isMinimized = [MatDesktopInput]::IsIconic($handle)
    $pidCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
      $process.Id
    )
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition)
    $fallbackWindow = $null
    for ($i = 0; $i -lt $windows.Count; $i++) {
      $window = $windows.Item($i)
      if ($null -eq $fallbackWindow) { $fallbackWindow = $window }
      if ($window.Current.Name -ne "Codex") { continue }
      return [ordered]@{
        process = $process
        window = $window
        minimized = $isMinimized
      }
    }

    if ($null -ne $fallbackWindow) {
      return [ordered]@{
        process = $process
        window = $fallbackWindow
        minimized = $isMinimized
      }
    }

    $windowFromHandle = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -ne $windowFromHandle) {
      return [ordered]@{
        process = $process
        window = $windowFromHandle
        minimized = $isMinimized
      }
    }
  }

  return $null
}

function Find-CodexDesktop {
  $target = Find-CodexDesktopWindow
  if ($null -eq $target) { return $null }

  if ([bool]$target.minimized) {
    $target.input = $null
    $target.inputRect = $null
    $target.inputSynthetic = $false
    $target.remoteControlPageVisible = $false
    $target.send = $null
    return $target
  }

  $remoteControlPageVisible = Test-OwnRemotePageVisible $target.window
  $input = Find-DescendantByControlTypeAndName $target.window ([System.Windows.Automation.ControlType]::Edit) $fallbackComposerNames
  if ($null -eq $input) { $input = Find-BottomEdit $target.window }
  $send = $null
  if ($null -ne $input) { $send = Find-BottomSendButton $target.window $input }
  if ($null -eq $send -and -not $remoteControlPageVisible) { $send = Find-BottomActionButton $target.window "right" }

  $target.input = $input
  $target.inputRect = $null
  $target.inputSynthetic = $false
  $target.remoteControlPageVisible = $remoteControlPageVisible
  if ($null -eq $input -and $null -ne $send) {
    $syntheticBounds = Find-SyntheticComposerBounds $target.window $send
    if ($null -ne $syntheticBounds) {
      $target["inputRect"] = $syntheticBounds
      $target["inputSynthetic"] = $true
    }
  }
  $target.send = $send
  return $target
}

function Target-IsReady($target) {
  return $null -ne $target -and (-not [bool]$target.remoteControlPageVisible) -and (-not (Test-ComposerStopVisible $target)) -and ($null -ne $target.input -or $null -ne $target.inputRect) -and $null -ne $target.send
}

function Test-ComposerStopVisible($target) {
  if ($null -eq $target) { return $false }
  $bottomButtons = Get-BottomButtons $target.window
  $windowBounds = $target.window.Current.BoundingRectangle
  foreach ($button in $bottomButtons) {
    $isStop = Test-IsStopName $button.name
    $inComposerActionArea =
      $button.bounds.x -gt ($windowBounds.X + ($windowBounds.Width * 0.65)) -and
      $button.bounds.y -gt ($windowBounds.Y + ($windowBounds.Height * 0.82))
    if ($isStop -and $inComposerActionArea) { return $true }
  }
  return $false
}

function Target-UnavailableReason($target) {
  if ($null -eq $target) { return "Codex Desktop window was not found." }

  if (Test-ComposerStopVisible $target) { return "Codex Desktop composer shows a Stop button, so the current window is running a turn." }
  if ([bool]$target.minimized) { return "Codex Desktop is minimized; it will be restored before sending." }
  if ([bool]$target.remoteControlPageVisible) { return "The remote control page is open inside Codex Desktop; open it from a phone or a separate Chrome window to avoid targeting the remote page itself." }
  if ($null -eq $target.input -and $null -eq $target.inputRect) { return "Codex Desktop composer input was not found." }
  if ($null -eq $target.send) { return "Codex Desktop send button was not found." }
  return ""
}

function Try-OpenCodexDesktop {
  try {
    $workspace = (Get-Location).Path
    $local = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
    $binRoot = Join-Path $local "OpenAI\Codex\bin"
    $codexExe = $null

    if (Test-Path $binRoot) {
      $codexExe = Get-ChildItem -LiteralPath $binRoot -Recurse -Filter "codex.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    }

    if (-not $codexExe) { $codexExe = "codex" }

    Start-Process -FilePath $codexExe -ArgumentList @("app", $workspace) -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 3
  } catch {
    # Best-effort only; caller will still return a normal not-found result.
  }
}

function Find-CodexDesktopWithRetry {
  $target = Find-CodexDesktop
  if ($null -ne $target) { return $target }
  Try-OpenCodexDesktop
  return Find-CodexDesktop
}

function Describe-Target($target) {
  if ($null -eq $target) {
    return [ordered]@{
      found = $false
      ready = $false
      reason = "Codex Desktop window was not found."
    }
  }

  $process = $target.process
  $window = $target.window
  $input = $target.input
  $send = $target.send
  $sidebarConversations = @()
  $sidebarProjects = @()
  $visibleTranscript = @()
  if (-not [bool]$target.minimized) {
    $sidebarConversations = @(Get-DesktopSidebarConversations $window 10)
    $sidebarProjects = @(Get-DesktopSidebarProjects $window 10)
    $visibleTranscript = @(Get-VisibleTranscript $window 80)
  }
  $sidebarRunningCount = @($sidebarConversations | Where-Object { [bool]$_.running }).Count
  $composerReady = Target-IsReady $target
  $ready = $composerReady -and $sidebarRunningCount -eq 0
  $invoke = $null
  if ($composerReady) { $invoke = Get-Pattern $send ([System.Windows.Automation.InvokePattern]::Pattern) }
  $reason = Target-UnavailableReason $target
  if ($sidebarRunningCount -gt 0) {
    $reason = "Codex Desktop sidebar shows $sidebarRunningCount running conversation(s)."
  }

  $value = [ordered]@{
    found = $true
    ready = $ready
    composerReady = $composerReady
    reason = $reason
    minimized = [bool]$target.minimized
    remoteControlPageVisible = [bool]$target.remoteControlPageVisible
    sidebarHasRunning = $sidebarRunningCount -gt 0
    sidebarRunningCount = $sidebarRunningCount
    sidebarProjects = $sidebarProjects
    sidebarConversations = $sidebarConversations
    visibleTranscript = $visibleTranscript
    processId = $process.Id
    processPath = $process.Path
    hwnd = ("0x{0:X}" -f $window.Current.NativeWindowHandle)
    windowTitle = $window.Current.Name
    windowClass = $window.Current.ClassName
    windowBounds = To-RectObject $window.Current.BoundingRectangle
    bottomButtons = Get-BottomButtons $window
  }

  if ($null -ne $input) {
    $value.inputName = $input.Current.Name
    $value.inputRawValue = Read-Value $input
    $value.inputValue = Normalize-InputValue $input $value.inputRawValue
    $value.inputFocusable = $input.Current.IsKeyboardFocusable
    $value.inputBounds = To-RectObject $input.Current.BoundingRectangle
    $value.inputSynthetic = $false
  } elseif ($null -ne $target.inputRect) {
    $value.inputName = "synthetic-bottom-composer"
    $value.inputValue = ""
    $value.inputFocusable = $true
    $value.inputBounds = To-RectObject $target.inputRect
    $value.inputSynthetic = $true
  }

  if ($null -ne $send) {
    $value.sendName = $send.Current.Name
    $value.sendEnabled = $send.Current.IsEnabled
    $value.sendHasInvokePattern = $null -ne $invoke
    $value.sendBounds = To-RectObject $send.Current.BoundingRectangle
  }

  return $value
}

function Bring-ToForeground($target) {
  $handle = [IntPtr]::new([int64]$target.window.Current.NativeWindowHandle)
  [void][MatDesktopInput]::ShowWindow($handle, 9)
  [void][MatDesktopInput]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 250
}

function Get-InputBounds($target) {
  if ($null -ne $target.input) { return $target.input.Current.BoundingRectangle }
  return $target.inputRect
}

function Read-InputValue($target) {
  if ($null -ne $target.input) { return Read-NormalizedValue $target.input }
  return ""
}

function Paste-IntoInput($target, [string]$text) {
  Bring-ToForeground $target
  $clickPoint = Click-RectCenter (Get-InputBounds $target)
  Start-Sleep -Milliseconds 160
  [System.Windows.Forms.Clipboard]::SetText($text)
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 500
  return $clickPoint
}

function Clear-Input($target) {
  Bring-ToForeground $target
  [void](Click-RectCenter (Get-InputBounds $target))
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
  Start-Sleep -Milliseconds 220
  $remaining = Read-InputValue $target
  if ($remaining -and $null -ne $target.input) {
    [void](Set-Value $target.input "")
    Start-Sleep -Milliseconds 120
  }
}

function Invoke-Send($target) {
  $send = $target.send
  if ($null -eq $send -or -not $send.Current.IsEnabled) { return "not-enabled" }
  $invoke = Get-Pattern $send ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($null -ne $invoke -and $send.Current.IsEnabled) {
    $invoke.Invoke()
    Start-Sleep -Milliseconds 900
    return "invoke"
  }

  $point = Click-RectCenter $send.Current.BoundingRectangle
  Start-Sleep -Milliseconds 900
  return "click:$point"
}

function Complete($value) {
  $value.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $value | ConvertTo-Json -Depth 12 -Compress
}

try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $action = [string]$request.action
  $target = Find-CodexDesktopWithRetry
  $description = Describe-Target $target

  if ($action -eq "status") {
    Complete ([ordered]@{
      ok = [bool]$description.found
      action = $action
      target = $description
    })
    exit 0
  }

  if ($description.found -and [bool]$description.minimized) {
    Bring-ToForeground $target
    Start-Sleep -Milliseconds 900
    $target = Find-CodexDesktop
    $description = Describe-Target $target
  }

  if ($action -eq "focusConversation") {
    $index = 0
    try { $index = [int]$request.index } catch { $index = 0 }
    $candidates = @(Get-DesktopSidebarConversationCandidates $target.window 20)
    if ($index -lt 0 -or $index -ge $candidates.Count) {
      Complete ([ordered]@{
        ok = $false
        action = $action
        error = "Codex Desktop sidebar conversation was not found."
        requestedIndex = $index
        target = $description
      })
      exit 0
    }

    Bring-ToForeground $target
    $clicked = Click-RectCenter $candidates[$index].bounds
    Start-Sleep -Milliseconds 650
    $afterFocusTarget = Find-CodexDesktop
    if ($null -eq $afterFocusTarget) { $afterFocusTarget = $target }
    Complete ([ordered]@{
      ok = $true
      action = $action
      index = $index
      clicked = $clicked
      target = $description
      afterFocus = Describe-Target $afterFocusTarget
    })
    exit 0
  }

  if (-not $description.ready) {
    Complete ([ordered]@{
      ok = $false
      action = $action
      error = $description.reason
      target = $description
    })
    exit 0
  }

  $text = [string]$request.text
  if ([string]::IsNullOrWhiteSpace($text)) {
    $text = "DESKTOP_CONTROL_DRAFT_PROBE_" + (Get-Date -Format "HHmmss")
  }

  $existing = Read-InputValue $target
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    Complete ([ordered]@{
      ok = $false
      action = $action
      error = "Codex Desktop composer already contains text; refusing to overwrite it."
      existingLength = $existing.Length
      target = $description
    })
    exit 0
  }

  $savedClipboard = Save-Clipboard
  try {
    $clickPoint = Paste-IntoInput $target $text
    $readBack = Read-InputValue $target
    $afterPaste = Describe-Target $target
    $pasteVerified = ($readBack -eq $text) -or [bool]$afterPaste.sendEnabled -or [bool]$afterPaste.inputSynthetic

    if ($action -eq "draft") {
      Clear-Input $target
      $afterClear = Describe-Target $target
      Complete ([ordered]@{
        ok = ($pasteVerified -and [bool]$afterPaste.sendEnabled -and (-not [bool]$afterClear.sendEnabled) -and ($afterClear.inputValue -eq ""))
        action = $action
        text = $text
        readBack = $readBack
        clickPoint = $clickPoint
        target = $afterPaste
        afterClear = $afterClear
      })
      exit 0
    }

    if ($action -eq "send") {
      if (-not $pasteVerified) {
        Clear-Input $target
        Complete ([ordered]@{
          ok = $false
          action = $action
          error = "Text paste verification failed."
          text = $text
          readBack = $readBack
          target = $afterPaste
        })
        exit 0
      }

      if (-not $afterPaste.sendEnabled) {
        Clear-Input $target
        Complete ([ordered]@{
          ok = $false
          action = $action
          error = "Send button did not become enabled after paste."
          text = $text
          readBack = $readBack
          target = $afterPaste
        })
        exit 0
      }

      $sendMethod = Invoke-Send $target
      $afterSendTarget = Find-CodexDesktop
      if ($null -eq $afterSendTarget) { $afterSendTarget = $target }
      $afterSend = Describe-Target $afterSendTarget
      Complete ([ordered]@{
        ok = ($afterSend.inputValue -eq "" -or -not [bool]$afterSend.sendEnabled)
        action = $action
        text = $text
        readBack = $readBack
        clickPoint = $clickPoint
        sendMethod = $sendMethod
        target = $afterPaste
        afterSend = $afterSend
      })
      exit 0
    }

    Clear-Input $target
    Complete ([ordered]@{
      ok = $false
      action = $action
      error = "Unknown desktop control action."
      target = $description
    })
    exit 0
  } finally {
    Restore-Clipboard $savedClipboard
  }
} catch {
  Complete ([ordered]@{
    ok = $false
    action = "unknown"
    error = $_.Exception.Message
    details = $_.ScriptStackTrace
  })
  exit 0
}
