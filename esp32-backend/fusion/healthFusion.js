// analyzeHealth — works with temperatureF (Fahrenheit)
function analyzeHealth(hr, spo2, tempF) {
  const indicators = [];
  let riskScore    = 0;

  const spo2Connected = spo2 !== -1 && spo2 != null;

  if (hr > 100 && spo2Connected && spo2 >= 95 && tempF < 100.4) {
    indicators.push("Stress detected");
    riskScore += 2;
  }
  if (tempF >= 100.4 && hr > 95) {
    indicators.push("Fever risk");
    riskScore += 3;
  }
  if (spo2Connected && spo2 < 92 && hr <= 100) {
    indicators.push("Respiratory concern");
    riskScore += 4;
  }
  if (!spo2Connected) {
    indicators.push("SpO₂ sensor disconnected");
    riskScore += 1;
  }
  if (indicators.length === 0) {
    indicators.push("Normal");
  }

  return { indicators, riskScore };
}

module.exports = analyzeHealth;
