"use strict";
const express = require("express");
const { body, validationResult } = require("express-validator");

const router                       = express.Router();
const User                         = require("../models/User");
const { protect, authorizeRoles }  = require("../middleware/auth");

// All routes in this file require a valid JWT + admin role.
// protect()        — verifies JWT, attaches req.user
// authorizeRoles() — returns 403 if role !== "admin"
const adminOnly = [protect, authorizeRoles("admin")];

// ─── Validation error helper ──────────────────────────────────────────────────
function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const mapped = {};
    errors.array().forEach(e => { if (!mapped[e.path]) mapped[e.path] = e.msg; });
    res.status(422).json({ error: "Validation failed", fields: mapped });
    return true;
  }
  return false;
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
/**
 * Return all registered users (excluding passwords).
 * Sorted: admins first, then by name ascending.
 *
 * Returns: { users: [...] }
 */
router.get("/users", adminOnly, async (req, res) => {
  try {
    const users = await User.find({})
      .select("-password")
      .sort({ role: 1, name: 1 })
      .lean();

    res.status(200).json({ users });
  } catch (err) {
    console.error("[GET /api/admin/users]", err);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// ─── PATCH /api/admin/users/:id/role ─────────────────────────────────────────
/**
 * Change a user's role.
 *
 * Body: { role: "admin" | "doctor" | "nurse" | "viewer" }
 *
 * Constraints:
 *   • Admin cannot change their own role (prevents accidental self-demotion)
 *   • Cannot demote the last active admin
 *
 * Returns: { message, user }
 */
router.patch(
  "/users/:id/role",
  adminOnly,
  [
    body("role")
      .notEmpty().withMessage("Role is required")
      .isIn(["admin", "doctor", "nurse", "viewer"])
      .withMessage("Role must be one of: admin, doctor, nurse, viewer"),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const { id }   = req.params;
      const { role } = req.body;

      // ── Self-modification guard ────────────────────────────────────────────
      if (id === String(req.user._id)) {
        return res.status(403).json({
          error: "You cannot change your own role. Ask another admin to do this.",
        });
      }

      const target = await User.findById(id);
      if (!target) {
        return res.status(404).json({ error: "User not found." });
      }

      // ── Last-admin guard ───────────────────────────────────────────────────
      // If we're demoting an admin, ensure at least one other active admin remains.
      if (target.role === "admin" && role !== "admin") {
        const adminCount = await User.countDocuments({ role: "admin", isActive: true });
        if (adminCount <= 1) {
          return res.status(409).json({
            error: "Cannot demote the last active admin. Promote another user to admin first.",
          });
        }
      }

      target.role = role;
      await target.save();

      res.status(200).json({
        message: `Role updated to "${role}" for ${target.name}.`,
        user:    target.toPublicJSON(),
      });

    } catch (err) {
      console.error("[PATCH /api/admin/users/:id/role]", err);
      res.status(500).json({ error: "Failed to update role." });
    }
  }
);

// ─── PATCH /api/admin/users/:id/status ───────────────────────────────────────
/**
 * Activate or deactivate a user account.
 *
 * Body: { isActive: true | false }
 *
 * Constraints:
 *   • Admin cannot deactivate themselves
 *   • Cannot deactivate the last active admin
 *
 * Returns: { message, user }
 */
router.patch(
  "/users/:id/status",
  adminOnly,
  [
    body("isActive")
      .notEmpty().withMessage("isActive is required")
      .isBoolean().withMessage("isActive must be true or false"),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const { id }       = req.params;
      // express-validator coerces "true"/"false" strings — use toBoolean
      const isActive     = req.body.isActive === true || req.body.isActive === "true";

      // ── Self-deactivation guard ────────────────────────────────────────────
      if (id === String(req.user._id)) {
        return res.status(403).json({
          error: "You cannot deactivate your own account.",
        });
      }

      const target = await User.findById(id);
      if (!target) {
        return res.status(404).json({ error: "User not found." });
      }

      // ── Last-admin guard ───────────────────────────────────────────────────
      if (target.role === "admin" && !isActive) {
        const activeAdminCount = await User.countDocuments({ role: "admin", isActive: true });
        if (activeAdminCount <= 1) {
          return res.status(409).json({
            error: "Cannot deactivate the last active admin. Promote another user to admin first.",
          });
        }
      }

      target.isActive = isActive;
      await target.save();

      res.status(200).json({
        message: `Account for ${target.name} has been ${isActive ? "activated" : "deactivated"}.`,
        user:    target.toPublicJSON(),
      });

    } catch (err) {
      console.error("[PATCH /api/admin/users/:id/status]", err);
      res.status(500).json({ error: "Failed to update account status." });
    }
  }
);

module.exports = router;
