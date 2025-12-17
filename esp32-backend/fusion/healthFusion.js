function analyzeHealth(hr, spo2, temp) {
  let status = [];
  let riskScore = 0;

  // --- Stress ---
  if (hr > 100 && spo2 >= 95 && temp < 37.5) {
    status.push("Stress detected");
    riskScore += 2;
  }

  // --- Fever ---
  if (temp >= 37.8 && hr > 95) {
    status.push("Fever risk");
    riskScore += 3;
  }

  // --- Respiratory ---
  if (spo2 < 92 && hr <= 100) {
    status.push("Respiratory concern");
    riskScore += 4;
  }

  // --- Normal ---
  if (status.length === 0) {
    status.push("Normal");
  }

  return {
    indicators: status,
    riskScore
  };
}

module.exports = analyzeHealth;
