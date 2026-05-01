"use strict";
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const UserSchema = new mongoose.Schema(
  {
    name: {
      type:     String,
      required: [true, "Name is required"],
      trim:     true,
      minlength: [2,  "Name must be at least 2 characters"],
      maxlength: [80, "Name cannot exceed 80 characters"],
    },

    email: {
      type:     String,
      required: [true, "Email is required"],
      unique:   true,
      trim:     true,
      lowercase: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please provide a valid email address",
      ],
    },

    password: {
      type:     String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select:   false,   // never returned in queries unless explicitly asked
    },

    role: {
      type:    String,
      enum:    { values: ["admin", "doctor", "nurse", "viewer"], message: "Invalid role" },
      default: "admin",
    },

    profileImage: {
      type:    String,   // URL or relative path — optional
      default: null,
    },

    // Track last login for audit purposes
    lastLogin: {
      type:    Date,
      default: null,
    },

    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps: true,   // adds createdAt, updatedAt automatically
  }
);

// ─── Index ─────────────────────────────────────────────────────────────────────
// email is already indexed via unique:true above

// ─── Pre-save hook: hash password only when it has been modified ──────────────
// Note: Mongoose 9 dropped next() for async pre-hooks — await the promise directly.
UserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt    = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// ─── Instance method: compare plain password against stored hash ───────────────
UserSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password);
};

// ─── Instance method: safe public representation (no password) ────────────────
UserSchema.methods.toPublicJSON = function () {
  return {
    id:           this._id,
    name:         this.name,
    email:        this.email,
    role:         this.role,
    profileImage: this.profileImage,
    lastLogin:    this.lastLogin,
    createdAt:    this.createdAt,
  };
};

module.exports = mongoose.model("User", UserSchema);
