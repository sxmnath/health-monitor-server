const express = require("express");
const router = express.Router();
const mongoose  = require("mongoose");
const SensorData = require("../models/SensorData");
const Patient    = require("../models/Patient");
const analyzeHealth = require("../fusion/healthFusion");

router.get("/dashboard", async (req, res) => {
  const { patientId, deviceId } = req.query;

  // Short-circuit if DB is not connected
  if (mongoose.connection.readyState !== 1) {
    return res.json({ message: "No data yet" });
  }

  // Build filter: prefer patient_id, fall back to deviceId, else latest of any
  let filter = {};
  if (patientId)      filter = { patient_id: patientId };
  else if (deviceId)  filter = { deviceId };

  const latest = await SensorData.findOne(filter).sort({ time: -1 });
  if (!latest) return res.json({ message: "No data yet" });

  // Resolve patient name / id from Patient collection
  const pFilter = latest.patient_id
    ? { patient_id: latest.patient_id }
    : { deviceId: latest.deviceId };
  const patient = await Patient.findOne(pFilter).lean();

  const fusion = analyzeHealth(latest.heartRate, latest.spo2, latest.temperature);

  res.json({
    patient_id:  patient?.patient_id  || latest.patient_id || null,
    deviceId:    latest.deviceId,
    name:        patient?.name        || latest.deviceId,
    vitals: {
      heartRate:   latest.heartRate,
      spo2:        latest.spo2,
      temperature: latest.temperature,
    },
    fusion,
    time: latest.time,
  });
});

module.exports = router;
