const mongoose = require("mongoose");

const SensorSchema = new mongoose.Schema({
  temperature: Number,
  heartRate: Number,
  spo2: Number,
  deviceId: String,
  time: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("SensorData", SensorSchema);
