const mongoose = require("mongoose");

const SensorSchema = new mongoose.Schema({
  patient_id:   { type: String, required: true },
  deviceId:     { type: String, required: true },
  // Processed vitals (stored clean — raw rejected values are never written)
  heartRate:    { type: Number },          // bpm, already smoothed + validated
  spo2:         { type: Number },          // %, -1 = sensor not connected
  temperatureF: { type: Number },          // °F (converted from °C at ingest)
  // Signal meta
  isPeak:       { type: Boolean, default: false },  // true if detected as spike
  time:         { type: Date, default: Date.now },
});

// Compound index: fast range queries per patient sorted by time
SensorSchema.index({ patient_id: 1, time: -1 });
SensorSchema.index({ deviceId: 1, time: -1 });

module.exports = mongoose.model("SensorData", SensorSchema);
