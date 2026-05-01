"use strict";
const express = require("express");
const router  = express.Router();
const { body, validationResult } = require("express-validator");

const User                       = require("../models/User");
const { signToken, protect }     = require("../middleware/auth");

// ─── Validation rule sets ─────────────────────────────────────────────────────
const signupRules = [
  body("name")
    .trim()
    .notEmpty().withMessage("Name is required")
    .isLength({ min: 2, max: 80 }).withMessage("Name must be 2–80 characters"),

  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Must be a valid email address")
    .normalizeEmail(),

  body("password")
    .notEmpty().withMessage("Password is required")
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters")
    .matches(/[A-Za-z]/).withMessage("Password must contain at least one letter")
    .matches(/\d/).withMessage("Password must contain at least one number"),

  body("role")
    .optional()
    .isIn(["admin", "doctor", "nurse", "viewer"])
    .withMessage("Role must be one of: admin, doctor, nurse, viewer"),
];

const loginRules = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Must be a valid email address")
    .normalizeEmail(),

  body("password")
    .notEmpty().withMessage("Password is required"),
];

// ─── Validation error handler ─────────────────────────────────────────────────
function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return first error per field for a clean UX response
    const mapped = {};
    errors.array().forEach(e => { if (!mapped[e.path]) mapped[e.path] = e.msg; });
    res.status(422).json({ error: "Validation failed", fields: mapped });
    return true;   // caller should return after this
  }
  return false;
}

// ─── POST /auth/signup ────────────────────────────────────────────────────────
/**
 * Register a new user.
 *
 * Body: { name, email, password, role? }
 *
 * Returns: { user, token }
 */
router.post("/signup", signupRules, async (req, res) => {
  if (handleValidation(req, res)) return;

  try {
    const { name, email, password, role } = req.body;

    // Check for duplicate email before attempting insert (gives a friendlier error
    // than relying solely on the MongoDB unique index violation)
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({
        error:  "Email already registered",
        fields: { email: "An account with this email address already exists" },
      });
    }

    const user = await User.create({
      name,
      email,
      password,           // hashed by pre-save hook in User model
      role: role || "admin",
    });

    const token = signToken(user);

    // Update lastLogin on first registration
    user.lastLogin = new Date();
    await user.save();

    res.status(201).json({
      message: "Account created successfully",
      user:    user.toPublicJSON(),
      token,
    });

  } catch (err) {
    // Catch MongoDB duplicate key error as a safety net (race condition)
    if (err.code === 11000) {
      return res.status(409).json({
        error:  "Email already registered",
        fields: { email: "An account with this email address already exists" },
      });
    }
    console.error("[POST /auth/signup]", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────
/**
 * Authenticate an existing user.
 *
 * Body: { email, password }
 *
 * Returns: { user, token }
 */
router.post("/login", loginRules, async (req, res) => {
  if (handleValidation(req, res)) return;

  try {
    const { email, password } = req.body;

    // Explicitly select password since it's excluded by default (select: false)
    const user = await User.findOne({ email }).select("+password");

    // Use the same generic message for both "not found" and "wrong password"
    // to avoid user enumeration attacks
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: "Account is disabled. Contact an administrator.",
      });
    }

    const passwordMatch = await user.comparePassword(password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Update last login timestamp
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);

    res.status(200).json({
      message: "Login successful",
      user:    user.toPublicJSON(),
      token,
    });

  } catch (err) {
    console.error("[POST /auth/login]", err);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
/**
 * Return the currently authenticated user's profile.
 * Requires a valid Bearer token in Authorization header.
 *
 * Returns: { user }
 */
router.get("/me", protect, async (req, res) => {
  // req.user is already populated by the protect middleware (no password)
  res.status(200).json({
    user: req.user.toPublicJSON(),
  });
});

// ─── PATCH /auth/me ───────────────────────────────────────────────────────────
/**
 * Update the current user's own name or profileImage.
 * Password changes require a dedicated endpoint (not implemented here) so that
 * they can enforce re-entry of the old password.
 */
router.patch(
  "/me",
  protect,
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 80 }).withMessage("Name must be 2–80 characters"),
    body("profileImage")
      .optional()
      .isURL().withMessage("profileImage must be a valid URL"),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const allowed = ["name", "profileImage"];
      const update  = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

      const updated = await User.findByIdAndUpdate(
        req.user._id,
        update,
        { new: true, runValidators: true }
      );

      res.status(200).json({
        message: "Profile updated",
        user:    updated.toPublicJSON(),
      });
    } catch (err) {
      console.error("[PATCH /auth/me]", err);
      res.status(500).json({ error: "Server error. Please try again." });
    }
  }
);


// ─── PUT /auth/update ─────────────────────────────────────────────────────────
/**
 * Update the current user's profile info and/or password in a single endpoint.
 *
 * Body (all optional, send only what you want to change):
 *   { name, email, profileImage, currentPassword, newPassword }
 *
 * Rules:
 *   • name / email / profileImage → update allowed fields directly
 *   • newPassword requires currentPassword to be verified first
 *   • profileImage: base64 data URL or http(s) URL or null (to clear)
 *
 * Returns: { message, user }
 */
router.put(
  "/update",
  protect,
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 80 }).withMessage("Name must be 2–80 characters"),

    body("email")
      .optional()
      .trim()
      .isEmail().withMessage("Must be a valid email address")
      .normalizeEmail(),

    body("newPassword")
      .optional()
      .isLength({ min: 8 }).withMessage("Password must be at least 8 characters")
      .matches(/[A-Za-z]/).withMessage("Password must contain at least one letter")
      .matches(/\d/).withMessage("Password must contain at least one number"),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const { name, email, profileImage, currentPassword, newPassword } = req.body;
      const userId = req.user._id;

      // ── Password change ────────────────────────────────────────────────
      if (newPassword !== undefined) {
        if (!currentPassword) {
          return res.status(422).json({
            error:  "Validation failed",
            fields: { currentPassword: "Current password is required to set a new one" },
          });
        }

        // Re-fetch with password field (excluded by default)
        const userWithPw = await User.findById(userId).select("+password");
        const match = await userWithPw.comparePassword(currentPassword);
        if (!match) {
          return res.status(422).json({
            error:  "Validation failed",
            fields: { currentPassword: "Current password is incorrect" },
          });
        }

        userWithPw.password = newPassword; // pre-save hook will hash it
        await userWithPw.save();

        // If ONLY a password change was requested, return early
        const hasProfileChanges = name !== undefined || email !== undefined || profileImage !== undefined;
        if (!hasProfileChanges) {
          const fresh = await User.findById(userId);
          return res.status(200).json({ message: "Password updated", user: fresh.toPublicJSON() });
        }
      }

      // ── Profile field update ───────────────────────────────────────────
      const allowed = ["name", "email", "profileImage"];
      const update  = {};
      allowed.forEach(k => {
        if (req.body[k] !== undefined) update[k] = req.body[k];
      });

      if (Object.keys(update).length === 0 && newPassword === undefined) {
        return res.status(400).json({ error: "No changes provided" });
      }

      // Check for duplicate email before update
      if (update.email && update.email !== req.user.email) {
        const existing = await User.findOne({ email: update.email, _id: { $ne: userId } });
        if (existing) {
          return res.status(409).json({
            error:  "Email already in use",
            fields: { email: "An account with this email already exists" },
          });
        }
      }

      let updated = req.user;
      if (Object.keys(update).length > 0) {
        updated = await User.findByIdAndUpdate(
          userId,
          update,
          { new: true, runValidators: true }
        );
      }

      res.status(200).json({
        message: newPassword ? "Profile and password updated" : "Profile updated",
        user:    updated.toPublicJSON(),
      });

    } catch (err) {
      console.error("[PUT /auth/update]", err);
      res.status(500).json({
        error: err.message || "Server error",
        type:  err.name,
        ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
      });
    }
  }
);

module.exports = router;
