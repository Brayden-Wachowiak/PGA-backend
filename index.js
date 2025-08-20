const express = require("express");
const cors = require("cors");
require("dotenv").config();
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const he = require("he");
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Limit: 3 signups per 15 minutes per IP
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "Too many signup attempts. Please try again later.",
});

console.log("MONGO_URI from .env:", process.env.MONGO_URI);
mongoose.connect(process.env.MONGO_URI);
mongoose.connection.once("open", () => {
  console.log("MongoDB connected");
});

const EventSchema = new mongoose.Schema(
  {
    name: String,
    date: {
      type: Date,
      required: true,
    },
    duration: Number,
  },
  { versionKey: false }
);

const Event = mongoose.model("Event", EventSchema, "events");
const SigneeSchema = new mongoose.Schema(
  {
    childFirstName: { type: String, lowercase: true },
    childLastName: { type: String, lowercase: true },
    parentFirstName: { type: String, lowercase: true },
    parentLastName: { type: String, lowercase: true },
    parentPhoneNumber: String,
  },
  { _id: false }
); // Disable _id for signees

const SessionSchema = new mongoose.Schema({
  day: String,
  time: String,
  maxSignups: Number,
  price: Number,
  signees: [SigneeSchema], // Use the schema here
});

const ClassSchema = new mongoose.Schema({
  name: String,
  sessions: [SessionSchema],
  id: String,
});

const GymnasticsSchema = new mongoose.Schema(
  {
    classes: [ClassSchema],
    season: String,
  },
  { versionKey: false }
);

const Gymnastics = mongoose.model("Gymnastics", GymnasticsSchema, "signups");
const Upcoming = mongoose.model("Upcoming", GymnasticsSchema, "upcoming");

// GET route that returns both signups and upcoming
app.get("/classes", async (req, res) => {
  try {
    const signupsEntry = await Gymnastics.findOne(); // Expecting just one
    const upcomingEntry = await Upcoming.findOne(); // Possibly many

    if (!signupsEntry) return res.status(404).send("Signups not found");
    if (!upcomingEntry)
      return res.status(404).send("Upcoming classes not found");

    // Map over classes and sessions to replace signees list with just their count
    const signupsClassesWithCounts = signupsEntry.classes.map((cls) => ({
      ...cls.toObject(),
      sessions: cls.sessions.map((session) => ({
        ...session.toObject(),
        signees: session.signees.length, // Replace array with count
      })),
    }));

    const upcomingClassesWithCounts = upcomingEntry.classes.map((cls) => ({
      ...cls.toObject(),
      sessions: cls.sessions.map((session) => ({
        ...session.toObject(),
        signees: session.signees.length, // Replace array with count
      })),
    }));

    res.json({
      signups: {
        season: signupsEntry.season,
        classes: signupsClassesWithCounts,
      },
      upcoming: {
        season: upcomingEntry.season,
        classes: upcomingClassesWithCounts,
      },
    });
  } catch (err) {
    console.error("Failed to fetch classes and upcoming:", err);
    res.status(500).send("Server error");
  }
});

app.get("/events", async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1 });
    res.json(events);
  } catch (err) {
    console.error("Failed to fetch events:", err);
    res.status(500).send("Server error");
  }
});

const { body, validationResult } = require("express-validator");

app.post(
  "/class-signup",
  [
    // Top-level fields
    body("className").trim().escape().isLength({ min: 1, max: 100 }),
    body("day").trim().escape().isLength({ min: 1, max: 20 }),
    body("time").trim().escape().isLength({ min: 1, max: 20 }),

    // Nested signee fields
    body("signee.childFirstName").trim().escape().isLength({ min: 1, max: 50 }),
    body("signee.childLastName").trim().escape().isLength({ min: 1, max: 50 }),
    body("signee.parentFirstName")
      .trim()
      .escape()
      .isLength({ min: 1, max: 50 }),
    body("signee.parentLastName").trim().escape().isLength({ min: 1, max: 50 }),
    body("signee.parentPhoneNumber")
      .trim()
      .isMobilePhone()
      .withMessage("Invalid phone number"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.warn("Validation errors:", errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { className, day, time, signee } = req.body;

    try {
      const dbEntry = await Gymnastics.findOne();
      if (!dbEntry) return res.status(500).send("No class data found");

      const decodedClassName = he.decode(className);
      const classItem = dbEntry.classes.find(
        (c) => c.name === decodedClassName
      );
      if (!classItem) return res.status(404).send("Class not found");

      const session = classItem.sessions.find(
        (s) => s.day === day && s.time === time
      );
      if (!session) return res.status(404).send("Session not found");

      const signeeFirstName = signee.childFirstName.toLowerCase();
      const signeeLastName = signee.childLastName.toLowerCase();

      const alreadySignedUp = session.signees.some((s) => {
        return (
          s.childFirstName === signeeFirstName &&
          s.childLastName === signeeLastName
        );
      });

      if (alreadySignedUp) return res.status(400).send("Already signed up");

      if (session.signees.length >= session.maxSignups) {
        return res.status(400).send("Session is full");
      }

      const filters = [
        { "cls.name": decodedClassName },
        { "session.day": day, "session.time": time },
      ];

      const updatedDoc = await Gymnastics.findOneAndUpdate(
        {
          "classes.name": decodedClassName,
          "classes.sessions.day": day,
          "classes.sessions.time": time,
        },
        {
          $push: { "classes.$[cls].sessions.$[session].signees": signee },
        },
        {
          arrayFilters: filters,
          new: true, // return the updated document
        }
      );

      res.json({ message: "Signup successful" });
    } catch (err) {
      console.error("Signup failed:", err);
      res.status(500).send("Server error");
    }
  }
);
