$headers = @{'Content-Type' = 'application/json'}

$patients = @(
    @{ deviceId = 'ESP32_01'; heartRate = 78;  spo2 = 98; temperature = 36.8 },
    @{ deviceId = 'ESP32_02'; heartRate = 112; spo2 = 94; temperature = 37.7 },
    @{ deviceId = 'ESP32_03'; heartRate = 135; spo2 = 89; temperature = 38.9 }
)

foreach ($p in $patients) {
    $body = $p | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Uri 'http://localhost:3000/data' -Method POST -Headers $headers -Body $body
        Write-Host "[$($p.deviceId)] OK - $resp"
    } catch {
        Write-Host "[$($p.deviceId)] FAILED - $($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds 300
}

Write-Host "`nDone. Refresh http://localhost:3000/patients.html to see all 3 patients."
