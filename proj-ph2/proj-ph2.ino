#include "esp_camera.h"
#include "camera_config.h"
#include "model.h"

#include <WiFi.h>
#include <HTTPClient.h>
#include <Arduino_TensorFlowLite.h>
#include <U8g2lib.h>
#include <Wire.h>

#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/schema/schema_generated.h"

// ── User config ───────────────────────────────────────────────────
#define WIFI_SSID       "YOUR_WIFI_SSID"
#define WIFI_PASS       "YOUR_WIFI_PASSWORD"
#define SERVER_URL      "http://YOUR_RENDER_URL/violation"
// e.g. "http://helmet-violation.onrender.com/violation"
// For local testing use your PC's local IP:
// "http://192.168.1.XX:5000/violation"

#define CONFIDENCE_THRESHOLD  0.75f
#define LOOP_DELAY_MS         2000
#define WIFI_TIMEOUT_MS       15000

// ── OLED: 1.3" SSD1306, SCL=IO15, SDA=IO14 ───────────────────────
U8G2_SSD1306_128X64_NONAME_F_SW_I2C
  u8g2(U8G2_R0, /*SCL*/ 15, /*SDA*/ 14, U8X8_PIN_NONE);

// ── TFLite setup ──────────────────────────────────────────────────
namespace {
  tflite::MicroErrorReporter  micro_error_reporter;
  tflite::ErrorReporter*      error_reporter  = &micro_error_reporter;
  const tflite::Model*        model           = nullptr;
  tflite::MicroInterpreter*   interpreter     = nullptr;
  TfLiteTensor*               input           = nullptr;

  // Arena size: tune down if OOM, up if allocation fails
  constexpr int kTensorArenaSize = 80 * 1024;
  uint8_t tensor_arena[kTensorArenaSize];
}

// ── OLED helper ───────────────────────────────────────────────────
void showOLED(const char* line1,
              const char* line2 = "",
              const char* line3 = "") {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.drawStr(0, 12, line1);
  if (strlen(line2)) u8g2.drawStr(0, 28, line2);
  if (strlen(line3)) u8g2.drawStr(0, 44, line3);
  u8g2.sendBuffer();
}

// ── TFLite init ───────────────────────────────────────────────────
bool initTFLite() {
  model = tflite::GetModel(g_model);
  if (model->version() != TFLITE_SCHEMA_VERSION) {
    Serial.println("Model schema mismatch");
    return false;
  }

  static tflite::AllOpsResolver resolver;
  static tflite::MicroInterpreter static_interpreter(
    model, resolver, tensor_arena, kTensorArenaSize, error_reporter
  );
  interpreter = &static_interpreter;

  if (interpreter->AllocateTensors() != kTfLiteOk) {
    Serial.println("AllocateTensors failed");
    return false;
  }

  input = interpreter->input(0);
  Serial.printf("TFLite input shape: %d x %d x %d\n",
    input->dims->data[1],
    input->dims->data[2],
    input->dims->data[3]);
  return true;
}

// ── Nearest-neighbour resize: src_buf (JPEG decoded RGB) → 96×96 ──
// Called on top half of frame only (y=0 to h/2)
void resizeCropToInput(camera_fb_t* fb) {
  int src_w = fb->width;
  int src_h = fb->height / 2;   // top half only

  // fb->buf is raw RGB888 when pixel_format = PIXFORMAT_RGB888
  // We switch format to RGB for inference, see captureRGB() below
  for (int dy = 0; dy < 96; dy++) {
    for (int dx = 0; dx < 96; dx++) {
      int sx = dx * src_w / 96;
      int sy = dy * src_h / 96;
      int src_idx = (sy * src_w + sx) * 3;
      int dst_idx = (dy * 96  + dx) * 3;

      if (input->type == kTfLiteUInt8) {
        input->data.uint8[dst_idx]   = fb->buf[src_idx];
        input->data.uint8[dst_idx+1] = fb->buf[src_idx+1];
        input->data.uint8[dst_idx+2] = fb->buf[src_idx+2];
      } else {
        // Float model: normalise to -1..1
        input->data.f[dst_idx]   = (fb->buf[src_idx]   / 127.5f) - 1.0f;
        input->data.f[dst_idx+1] = (fb->buf[src_idx+1] / 127.5f) - 1.0f;
        input->data.f[dst_idx+2] = (fb->buf[src_idx+2] / 127.5f) - 1.0f;
      }
    }
  }
}

// ── Run inference, return no-helmet score ─────────────────────────
// Teachable Machine class order: index 0 = helmet, index 1 = no_helmet
// Adjust indices if your class order differs
float runInference(camera_fb_t* fb) {
  resizeCropToInput(fb);

  if (interpreter->Invoke() != kTfLiteOk) {
    Serial.println("Inference failed");
    return 0.0f;
  }

  TfLiteTensor* output = interpreter->output(0);
  float no_helmet_score = (output->type == kTfLiteUInt8)
    ? output->data.uint8[1] / 255.0f
    : output->data.f[1];

  Serial.printf("Helmet: %.2f  No-helmet: %.2f\n",
    (output->type == kTfLiteUInt8)
      ? output->data.uint8[0] / 255.0f
      : output->data.f[0],
    no_helmet_score);

  return no_helmet_score;
}

// ── POST plate crop (bottom half JPEG) to Flask ───────────────────
String postViolation(float confidence) {
  // Capture a fresh JPEG frame for the POST
  // (inference already consumed the RGB frame — camera returns JPEG now)
  sensor_t* s = esp_camera_sensor_get();
  s->set_framesize(s, FRAMESIZE_VGA);   // VGA for faster POST
  delay(100);

  camera_fb_t* jpeg_fb = esp_camera_fb_get();
  if (!jpeg_fb) return "CAM_ERROR";

  HTTPClient http;
  http.begin(SERVER_URL);
  http.setTimeout(10000);

  // Multipart body
  String boundary  = "----ESP32Boundary";
  String part_img  = "--" + boundary + "\r\n"
                     "Content-Disposition: form-data; "
                     "name=\"plate_crop\"; filename=\"plate.jpg\"\r\n"
                     "Content-Type: image/jpeg\r\n\r\n";
  String part_conf = "\r\n--" + boundary + "\r\n"
                     "Content-Disposition: form-data; name=\"confidence\"\r\n\r\n"
                     + String(confidence, 4) +
                     "\r\n--" + boundary + "--\r\n";

  size_t total = part_img.length() + jpeg_fb->len + part_conf.length();
  uint8_t* body = (uint8_t*)malloc(total);
  if (!body) {
    esp_camera_fb_return(jpeg_fb);
    return "OOM";
  }

  memcpy(body,                                    part_img.c_str(),  part_img.length());
  memcpy(body + part_img.length(),                jpeg_fb->buf,      jpeg_fb->len);
  memcpy(body + part_img.length() + jpeg_fb->len, part_conf.c_str(), part_conf.length());

  free(body);   // moved below after POST
  esp_camera_fb_return(jpeg_fb);

  // Rebuild — free was too early above, corrected:
  body = (uint8_t*)malloc(total);
  camera_fb_t* jpeg_fb2 = esp_camera_fb_get();
  memcpy(body,                                     part_img.c_str(),  part_img.length());
  memcpy(body + part_img.length(),                 jpeg_fb2->buf,     jpeg_fb2->len);
  memcpy(body + part_img.length() + jpeg_fb2->len, part_conf.c_str(), part_conf.length());
  esp_camera_fb_return(jpeg_fb2);

  http.addHeader("Content-Type",
                 "multipart/form-data; boundary=" + boundary);
  int code = http.POST(body, total);
  free(body);

  String plate = "UNKNOWN";
  if (code == 200) {
    String resp = http.getString();
    Serial.println("Server: " + resp);
    // Parse {"plate":"MH12AB1234",...}
    int start = resp.indexOf("\"plate\":\"") + 9;
    if (start > 8) {
      int end = resp.indexOf("\"", start);
      plate = resp.substring(start, end);
    }
  } else {
    Serial.printf("POST failed: %d\n", code);
  }
  http.end();

  // Restore SVGA for next inference cycle
  s->set_framesize(s, FRAMESIZE_SVGA);

  return plate;
}

// ── Wi-Fi connect ─────────────────────────────────────────────────
void connectWiFi() {
  showOLED("Connecting WiFi", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_TIMEOUT_MS) {
      showOLED("WiFi FAILED", "Check creds");
      Serial.println("WiFi timeout — halting");
      while (true) delay(1000);
    }
    delay(300);
    Serial.print(".");
  }

  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
  showOLED("WiFi OK", WiFi.localIP().toString().c_str());
  delay(1000);
}

// ── Setup ─────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n\n=== Helmet Violation System ===");

  // OLED
  u8g2.begin();
  showOLED("Booting...");

  // Camera — start in RGB888 for TFLite inference
  camera_config_t cfg = get_camera_config();
  cfg.pixel_format = PIXFORMAT_RGB888;
  cfg.frame_size   = FRAMESIZE_SVGA;
  cfg.fb_count     = 1;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    showOLED("CAM FAILED", "Check wiring");
    while (true) delay(1000);
  }
  showOLED("Camera OK");
  delay(500);

  // Wi-Fi
  connectWiFi();

  // TFLite
  showOLED("Loading model...");
  if (!initTFLite()) {
    showOLED("MODEL FAILED");
    while (true) delay(1000);
  }
  showOLED("Model OK");
  delay(500);

  showOLED("System ready", "Detecting...");
  Serial.println("Setup complete — entering detection loop");
}

// ── Main loop ─────────────────────────────────────────────────────
void loop() {
  // Reconnect if Wi-Fi dropped
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost — reconnecting");
    connectWiFi();
  }

  // Capture RGB frame for inference
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Frame capture failed");
    delay(500);
    return;
  }

  float score = runInference(fb);
  esp_camera_fb_return(fb);

  if (score >= CONFIDENCE_THRESHOLD) {
    // ── VIOLATION ────────────────────────────────────────────────
    Serial.println("VIOLATION detected — sending plate crop");
    showOLED("NO HELMET", "Sending...",
             (String(score * 100, 0) + "% conf").c_str());

    // Switch pixel format to JPEG for the POST
    sensor_t* s = esp_camera_sensor_get();
    s->set_pixformat(s, PIXFORMAT_JPEG);
    delay(50);

    String plate = postViolation(score);

    // Switch back to RGB for next inference
    s->set_pixformat(s, PIXFORMAT_RGB888);

    showOLED("VIOLATION",
             ("Plate: " + plate).c_str(),
             (String(score * 100, 0) + "%").c_str());

    Serial.println("Plate logged: " + plate);
    delay(3000);   // hold result on OLED longer

  } else {
    // ── CLEAR ────────────────────────────────────────────────────
    showOLED("HELMET OK",
             ("Conf: " + String(score * 100, 0) + "%").c_str());
  }

  delay(LOOP_DELAY_MS);
}