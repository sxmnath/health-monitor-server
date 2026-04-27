require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

//middleware
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => { req.io = io; next(); });

const path = require("path");
app.use(express.static(path.join(__dirname, "../esp32-frontend")));
//db
mongoose.connect(
  process.env.MONGO_URI
)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log(err));

const SensorData = require("./models/SensorData");
const Patient    = require("./models/Patient");

// Auto-generate next sequential patient_id (P101, P102 …)
async function assignPatientId(deviceId) {
  // Already registered?
  let patient = await Patient.findOne({ deviceId });
  if (patient) return patient;

  // Count existing patients to determine next ID number
  const count = await Patient.countDocuments();
  const patient_id = `P${101 + count}`;
  const name = `Patient ${count + 1}`;

  patient = await Patient.create({ patient_id, deviceId, name });
  console.log(`[Patient] Registered ${deviceId} → ${patient_id}`);
  return patient;
}

app.post("/data", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).send("deviceId required");

    // Auto-register device → patient_id
    const patient = await assignPatientId(deviceId);

    // Save reading with both identifiers
    const doc = await SensorData.create({
      ...req.body,
      patient_id: patient.patient_id,
    });

    // Push to patient-id WS room (dashboard subscribed by patient_id)
    io.to(patient.patient_id).emit("vitals-update", { ...doc.toObject(), patient_id: patient.patient_id, name: patient.name });
    // Notify ward list page
    io.emit("patient-list-update", { patient_id: patient.patient_id, deviceId });

    res.status(200).json({ status: "ok", patient_id: patient.patient_id });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

app.get("/data/recent", async (req, res) => {
  try {
    const { deviceId, seconds } = req.query;

    if (!deviceId || !seconds) {
      return res.status(400).json({
        error: "deviceId and seconds are required"
      });
    }

    const windowTime = parseInt(seconds) * 1000;
    const windowStart = new Date(Date.now() - windowTime);

    const data = await SensorData.find({
      deviceId: deviceId,
      timestamp: { $gte: windowStart }
    })
      .sort({ timestamp: 1 })
      .lean();

    res.status(200).json({
      deviceId,
      windowSeconds: seconds,
      count: data.length,
      data
    });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.use("/api", require("./routes/dashboard"));
app.use("/api", require("./routes/patients"));

// Expose patient registry
app.get("/api/patient-map", async (req, res) => {
  try {
    const map = await Patient.find({}, { _id: 0, patient_id: 1, deviceId: 1, name: 1 }).lean();
    res.json(map);
  } catch { res.json([]); }
});

const PORT = process.env.PORT || 3000;

io.on("connection", (socket) => {
  console.log("[WS] Client connected:", socket.id);

  // Dashboard joins patient_id room
  socket.on("join-patient", (patient_id) => {
    socket.join(patient_id);
    console.log(`[WS] ${socket.id} joined room: ${patient_id}`);
  });

  socket.on("disconnect", () => console.log("[WS] Client disconnected:", socket.id));
});

// Root → Patient List page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../esp32-frontend/patients.html"));
});

// Individual patient dashboard
app.get("/patient", (req, res) => {
  res.sendFile(path.join(__dirname, "../esp32-frontend/patient.html"));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});