const express = require("express");
const router = express.Router();
const SensorData = require("../models/SensorData");
const analyzeHealth = require("../fusion/healthFusion");

router.get("/dashboard", async (req, res) => {
  const latest = await SensorData.findOne().sort({ time: -1 });

  if (!latest) {
    return res.json({ message: "No data yet" });
  }

  const fusion = analyzeHealth(
    latest.heartRate,
    latest.spo2,
    latest.temperature
  );

  res.json({
    deviceId: latest.deviceId,
    vitals: {
      heartRate: latest.heartRate,
      spo2: latest.spo2,
      temperature: latest.temperature
    },
    fusion,
    time: latest.time
  });
});

module.exports = router;
