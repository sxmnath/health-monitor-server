const mongoose = require("mongoose");

const PatientSchema = new mongoose.Schema({
  patient_id: { type: String, required: true, unique: true, trim: true },
  deviceId:   { type: String, required: true, unique: true, trim: true },
  name:       { type: String, default: "" },
  // Profile fields — all optional, filled via edit modal
  age:        Number,
  gender:     String,
  bloodType:  String,
  weight:     Number,   // kg
  height:     Number,   // cm
  roomNo:     String,
  ward:       String,
  physician:  String,
  diagnosis:  String,
  phone:      String,
  notes:      String,
  createdAt:  { type: Date, default: Date.now },
});

module.exports = mongoose.model("Patient", PatientSchema);
