const mongoose = require("mongoose");

const PatientSchema = new mongoose.Schema({
  patient_id: {
    type: String,
    required: true,
    unique: true,   // e.g. "P101", "P102"
    trim: true,
  },
  deviceId: {
    type: String,
    required: true,
    unique: true,   // one device per patient
    trim: true,
  },
  name: {
    type: String,
    default: "",    // human-readable display name
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Patient", PatientSchema);
