const express = require("express");
const router = express.Router();
const mongoose  = require("mongoose");
const SensorData    = require("../models/SensorData");
const Patient       = require("../models/Patient");
const analyzeHealth = require("../fusion/healthFusion");

function getStatus(vitals) {
  const { heartRate: hr, spo2, temperature: temp } = vitals;
  if (hr > 120 || hr < 60 || spo2 < 92 || temp > 38) return "critical";
  if (hr > 100 || spo2 <= 95 || temp >= 37.5)         return "warning";
  return "stable";
}

function demoPatients() {
  return [
    { patient_id: "P103", deviceId: "ESP32_03", name: "Patient 3", vitals: { heartRate: 135, spo2: 89,  temperature: 38.9 } },
    { patient_id: "P102", deviceId: "ESP32_02", name: "Patient 2", vitals: { heartRate: 112, spo2: 94,  temperature: 37.7 } },
    { patient_id: "P101", deviceId: "ESP32_01", name: "Patient 1", vitals: { heartRate: 78,  spo2: 98,  temperature: 36.8 } },
  ].map(p => ({
    ...p,
    fusion:   analyzeHealth(p.vitals.heartRate, p.vitals.spo2, p.vitals.temperature),
    status:   getStatus(p.vitals),
    lastSeen: new Date(),
  }));
}

router.get("/patients", async (req, res) => {
  // Short-circuit: DB not ready → instant demo response
  if (mongoose.connection.readyState !== 1) {
    console.warn("[/api/patients] DB not connected, serving demo data");
    return res.json(demoPatients());
  }

  try {
    // Source of truth: Patient collection (each registered device)
    const patients = await Patient.find({}).lean();


    if (!patients.length) return res.json([]);

    // For each patient fetch their latest SensorData reading
    const results = await Promise.all(
      patients.map(async (p) => {
        const latest = await SensorData
          .findOne({ patient_id: p.patient_id })
          .sort({ time: -1 })
          .maxTimeMS(5000)
          .lean();

        if (!latest) return null;

        const vitals = {
          heartRate:   latest.heartRate,
          spo2:        latest.spo2,
          temperature: latest.temperature,
        };
        const fusion = analyzeHealth(vitals.heartRate, vitals.spo2, vitals.temperature);

        return {
          patient_id: p.patient_id,
          deviceId:   p.deviceId,
          name:       p.name,
          vitals,
          fusion,
          status:   getStatus(vitals),
          lastSeen: latest.time,
        };
      })
    );

    // Sort: critical first → warning → stable
    const order = { critical: 0, warning: 1, stable: 2 };
    const sorted = results
      .filter(Boolean)
      .sort((a, b) => order[a.status] - order[b.status]);

    res.json(sorted);

  } catch (err) {
    // DB not available — return demo data so UI is demostrable offline
    console.warn("[/api/patients] DB unavailable, serving demo data:", err.message);
    const demo = [
      { patient_id: "P103", deviceId: "ESP32_03", name: "Patient 3", vitals: { heartRate: 135, spo2: 89,  temperature: 38.9 } },
      { patient_id: "P102", deviceId: "ESP32_02", name: "Patient 2", vitals: { heartRate: 112, spo2: 94,  temperature: 37.7 } },
      { patient_id: "P101", deviceId: "ESP32_01", name: "Patient 1", vitals: { heartRate: 78,  spo2: 98,  temperature: 36.8 } },
    ].map(p => ({
      ...p,
      fusion:   analyzeHealth(p.vitals.heartRate, p.vitals.spo2, p.vitals.temperature),
      status:   getStatus(p.vitals),
      lastSeen: new Date(),
    }));
    res.json(demo);
  }
});

module.exports = router;
