# Logical Patient ID Architecture Documentation

This document summarizes the changes made to the Health Monitor system to transition from raw physical device identification to a logical Patient ID system (`P101`, `P102`, etc.).

## Rationale
Previously, the system directly mapped physical IoT devices (`ESP32_01`) to the UI. If a device was swapped or reassigned, the patient history would break. By abstracting the hardware to a logical `patient_id` model, the system gains several benefits:
- **Clinical Abstraction**: Doctors see "Patient P101" instead of "Device ESP32_01".
- **Hardware Separation**: A broken device can be replaced without losing the patient's identity.
- **Improved UI/UX**: Distinct patient ID badges allow for cleaner patient navigation.

---

## 1. Database Schema Changes

We introduced a two-tiered mapping approach using MongoDB Mongoose models.

### `models/Patient.js` (NEW)
A new registry that acts as the source of truth for all patients.
- **`patient_id`** (e.g., `P101`): The primary, human-readable unique identifier.
- **`deviceId`**: The physical device currently assigned to the patient.
- **`name`**: An optional human-readable label (e.g., "Patient 1").

### `models/SensorData.js` (UPDATED)
- Added the `patient_id` field alongside the `deviceId`. 
- **Effect**: All new sensor readings are tagged with both the hardware source and the logical patient identity, enabling queries against `patient_id` while preserving the hardware trail.

---

## 2. Auto-Registration System (`server.js`)

When the ESP32 posts data to `/data`, the backend automatically resolves or registers the patient.

- **Auto-Assignment Logic**: The system checks if `deviceId` is already associated with a `Patient`. If not, it automatically generates the next sequential ID (e.g., `P101`, `P102`) and registers them.
- **Stamping Data**: The `SensorData` document is saved containing the newly assigned `patient_id`.
- **WebSocket Rooms**: Live updates are now broadcasted to Socket.io rooms named after the `patient_id` instead of the `deviceId` (e.g., `io.to("P101").emit()`), isolating network traffic strictly per-patient.

---

## 3. Backend API Modernization

### Ward Overview API (`routes/patients.js`)
- **Old Behavior**: Scanned the `SensorData` collection for distinct device IDs.
- **New Behavior**: Queries the `Patient` collection to get all registered patients, then fetches their latest sensor data using `patient_id`.
- **Demo Fallback**: In the event MongoDB is disconnected, it immediately falls back to demo data featuring `P101`, `P102`, and `P103`, allowing the system to be demonstrable offline.

### Dashboard Data API (`routes/dashboard.js`)
- **Old Behavior**: Accepted a raw `?deviceId=` query parameter.
- **New Behavior**: Prioritizes `?patientId=` but maintains backward compatibility with `deviceId`. It joins data from the `SensorData` and `Patient` models to return a unified payload containing the physical device, the logical ID, and the patient's display name.

---

## 4. Frontend & UI Overhaul

### Ward Overview (`patients.js` & `patients.css`)
- **ID Pill Badges**: Cards now render a discrete, styled ID badge (e.g., `<span class="pid-badge">P101</span>`) beside the health status.
- **Deep Linking**: The "View Dashboard" link was updated to route by patient ID (`/patient?id=P101`) rather than the hardware ID.

### Patient Dashboard (`app.js`)
- **Routing**: The dashboard now extracts `id=P101` from the URL, automatically detecting if it's a logical ID or legacy hardware ID, and requests the appropriate API endpoint.
- **Header Updating**: The dashboard header now proudly displays "Health Monitor — Patient 1" or "P101". 
- **Empty State Fix**: Implemented graceful error handling. If a patient is newly created and has no data, the page falls back to a clean "Waiting for data..." state without throwing console errors.

---

## Conclusion
The application is now a true multi-patient monitoring dashboard. The ESP32 hardware acts merely as a data transmitter, while the Node backend takes over the responsibility of mapping hardware telemetry to persistent, identifiable patient records.
