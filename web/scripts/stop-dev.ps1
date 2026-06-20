# Освобождает порты dev-сервера (5173 Vite, 3001 Express)
$ports = 5173, 3001
foreach ($port in $ports) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object {
      $procId = $_.OwningProcess
      if ($procId -gt 0) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped PID $procId (port $port)"
      }
    }
}
