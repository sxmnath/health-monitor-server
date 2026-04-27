const mongoose = require("mongoose");

const SensorSchema = new mongoose.Schema({
  patient_id:  { type: String, index: true },   // e.g. "P101"
  deviceId:    { type: String, index: true },   // e.g. "ESP32_01"
  heartRate:   Number,
  spo2:        Number,
  temperature: Number,
  time: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("SensorData", SensorSchema);
