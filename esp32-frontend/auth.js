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
      lastLogin: new Date(),   // set here to avoid a second save() triggering re-hash
    });

    const token = signToken(user);

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

    // Use updateOne to avoid triggering the pre-save password hook
    await User.updateOne({ _id: user._id }, { lastLogin: new Date() });

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

module.exports = router;
