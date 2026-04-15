require('dotenv').config();

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// ✅ HOMEPAGE ROUTE (FIX)
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
// 🔌 DATABASE (ATLAS)
// =========================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ DB Error:", err));

// =========================
// 👤 USER MODEL
// =========================
const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  credits: { type: Number, default: 30 },
  plan: { type: String, default: "free" },
  role: { type: String, default: "user" }
}));

// =========================
// 🎬 CLIP MODEL
// =========================
const Clip = mongoose.model('Clip', new mongoose.Schema({
  userId: String,
  file: String,
  score: Number,
  createdAt: { type: Date, default: Date.now }
}));

// =========================
// 💳 RECHARGE MODEL
// =========================
const Recharge = mongoose.model('Recharge', new mongoose.Schema({
  userId: String,
  type: String,
  txHash: String,
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now }
}));

// =========================
// 🔐 AUTH
// =========================
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });

  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// =========================
// 🛡 ADMIN CHECK
// =========================
async function adminOnly(req, res, next) {
  const user = await User.findById(req.user.id);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

// =========================
// 🧾 REGISTER
// =========================
app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    const hashed = await bcrypt.hash(password, 10);
    await User.create({ email, password: hashed });

    res.json({ message: "User created" });
  } catch {
    res.status(400).json({ error: "User exists" });
  }
});

// =========================
// 🔑 LOGIN
// =========================
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Wrong password" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);

    res.json({ token });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// =========================
// 👤 GET USER
// =========================
app.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id);

  res.json({
    email: user.email,
    credits: user.credits,
    plan: user.plan,
    role: user.role
  });
});

// =========================
// 📤 UPLOAD CONFIG
// =========================
const upload = multer({ dest: 'uploads/' });

// =========================
// 🎯 VIRAL SCORE
// =========================
function getViralScore() {
  return Math.floor(Math.random() * 100);
}

// =========================
// 🎬 AUTO CUT
// =========================
app.post('/auto-cut', auth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const user = await User.findById(req.user.id);

    const fileSizeMB = req.file.size / (1024 * 1024);
    const cost = Math.ceil(fileSizeMB * 10);

    if (user.credits < cost) {
      return res.status(400).json({ error: "Not enough credits" });
    }

    user.credits -= cost;
    await user.save();

    const inputPath = req.file.path;
    const duration = parseInt(req.body.duration) || 10;

    let clips = [];

    for (let i = 0; i < 3; i++) {
      const output = `clip-${Date.now()}-${i}.mp4`;

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(i * 5)
          .setDuration(duration)
          .videoFilters([
            "crop='ih*9/16:ih'",
            "scale=720:1280"
          ])
          .output(output)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      const result = await cloudinary.uploader.upload(output, {
        resource_type: "video"
      });

      const score = getViralScore();

      await Clip.create({
        userId: req.user.id,
        file: result.secure_url,
        score
      });

      clips.push({ file: result.secure_url, score });

      safeDelete(output);
    }

    safeDelete(inputPath);

    res.json({
      clips,
      creditsLeft: user.credits
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Processing failed" });
  }
});

// =========================
// 🧹 SAFE DELETE
// =========================
function safeDelete(path) {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } catch {}
}

// =========================
// 🚀 START (RENDER FIX)
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});