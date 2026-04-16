require('dotenv').config();

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

// =========================
// ✅ CORS (SAFE)
// =========================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// ✅ ENSURE UPLOAD FOLDER
// =========================
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// =========================
// ✅ KEEP ALIVE ROUTE (VERY IMPORTANT)
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Backend is LIVE and working!");
});

// =========================
// ☁️ CLOUDINARY
// =========================
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// =========================
// 🔌 DATABASE (STABLE)
// =========================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ DB Error:", err));

// =========================
// MODELS
// =========================
const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  credits: { type: Number, default: 30 },
  plan: { type: String, default: "free" },
  role: { type: String, default: "user" }
}));

const Clip = mongoose.model('Clip', new mongoose.Schema({
  userId: String,
  file: String,
  score: Number,
  createdAt: { type: Date, default: Date.now }
}));

const Recharge = mongoose.model('Recharge', new mongoose.Schema({
  userId: String,
  type: String,
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now }
}));

// =========================
// AUTH
// =========================
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });

  try {
    const token = header.split(" ")[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =========================
// REGISTER
// =========================
app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: "User exists" });

    const hashed = await bcrypt.hash(password, 10);
    await User.create({ email, password: hashed });

    res.json({ message: "User created" });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

// =========================
// LOGIN
// =========================
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Wrong password" });

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" } // ✅ added expiry
    );

    res.json({ token });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// =========================
// GET USER
// =========================
app.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id);

  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    email: user.email,
    credits: user.credits,
    plan: user.plan
  });
});

// =========================
// UPLOAD CONFIG (LIMIT SIZE)
// =========================
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// =========================
// UTILITIES
// =========================
function getViralScore() {
  return Math.floor(Math.random() * 100);
}

function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

// =========================
// AUTO CUT
// =========================
app.post('/auto-cut', auth, upload.single('video'), async (req, res) => {
  let inputPath, output;

  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const user = await User.findById(req.user.id);

    if (user.credits < 5) {
      return res.status(400).json({ error: "Not enough credits" });
    }

    user.credits -= 5;
    await user.save();

    inputPath = req.file.path;
    output = path.join('uploads', `clip-${Date.now()}.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setDuration(10)
        .output(output)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const result = await cloudinary.uploader.upload(output, {
      resource_type: "video"
    });

    const clip = await Clip.create({
      userId: req.user.id,
      file: result.secure_url,
      score: getViralScore()
    });

    res.json({ clip });

  } catch (err) {
    console.log("AUTO CUT ERROR:", err);
    res.status(500).json({ error: "Processing failed" });
  } finally {
    safeDelete(inputPath);
    safeDelete(output);
  }
});

// =========================
// GET CLIPS
// =========================
app.get('/my-clips', auth, async (req, res) => {
  const clips = await Clip.find({ userId: req.user.id }).sort({ createdAt: -1 });
  res.json(clips);
});

// =========================
// VIDEO TO ANIMATION
// =========================
app.post('/video-to-animation', auth, upload.single('video'), async (req, res) => {
  let filePath;

  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    filePath = req.file.path;

    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "video"
    });

    await Clip.create({
      userId: req.user.id,
      file: result.secure_url,
      score: getViralScore()
    });

    res.json({ message: "Converted" });

  } catch (err) {
    console.log("ANIMATION ERROR:", err);
    res.status(500).json({ error: "Conversion failed" });
  } finally {
    safeDelete(filePath);
  }
});

// =========================
// REQUEST RECHARGE
// =========================
app.post('/request-recharge', auth, async (req, res) => {
  try {
    const { type } = req.body;

    if (!type) return res.status(400).json({ error: "Type required" });

    await Recharge.create({
      userId: req.user.id,
      type
    });

    res.json({ message: "Request sent" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// =========================
// GLOBAL ERROR HANDLER
// =========================
process.on("unhandledRejection", err => {
  console.log("UNHANDLED ERROR:", err);
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});