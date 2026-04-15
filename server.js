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
app.use(express.static(__dirname));

// =========================
// ☁️ CLOUDINARY
// =========================
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// =========================
// 🔌 DATABASE
// =========================
mongoose.connect('mongodb://127.0.0.1:27017/videoAI')
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log(err));

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
// 💳 RECHARGE MODEL (UPDATED)
// =========================
const Recharge = mongoose.model('Recharge', new mongoose.Schema({
  userId: String,
  type: String, // bank or crypto
  txHash: String, // optional transaction hash
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
// 🎨 VIDEO → ANIMATION
// =========================
app.post('/video-to-animation', auth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const user = await User.findById(req.user.id);

    if (user.plan !== "pro") {
      return res.status(403).json({ error: "Pro feature only" });
    }

    const cost = 20;
    if (user.credits < cost) {
      return res.status(400).json({ error: "Not enough credits" });
    }

    user.credits -= cost;
    await user.save();

    const inputPath = req.file.path;
    const output = `animation-${Date.now()}.mp4`;

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters([
          "fps=12",
          "eq=contrast=1.4:saturation=1.5",
          "edgedetect=low=0.1:high=0.3",
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

    await Clip.create({
      userId: req.user.id,
      file: result.secure_url,
      score: getViralScore()
    });

    safeDelete(inputPath);
    safeDelete(output);

    res.json({
      file: result.secure_url,
      creditsLeft: user.credits
    });

  } catch (err) {
    res.status(500).json({ error: "Animation failed" });
  }
});

// =========================
// 📊 USER CLIPS
// =========================
app.get('/my-clips', auth, async (req, res) => {
  const clips = await Clip.find({ userId: req.user.id }).sort({ score: -1 });
  res.json(clips);
});

// =========================
// 💳 REQUEST RECHARGE (UPDATED)
// =========================
app.post('/request-recharge', auth, async (req, res) => {
  const { type, txHash } = req.body;

  if (!type) {
    return res.status(400).json({ error: "Payment type required" });
  }

  await Recharge.create({
    userId: req.user.id,
    type,
    txHash: txHash || ""
  });

  res.json({ message: "Request sent" });
});

// =========================
// 🧑‍💼 ADMIN ROUTES
// =========================
app.get('/admin/recharges', auth, adminOnly, async (req, res) => {
  const list = await Recharge.find().sort({ createdAt: -1 });
  res.json(list);
});

// =========================
// APPROVE
// =========================
app.post('/admin/approve/:id', auth, adminOnly, async (req, res) => {
  const recharge = await Recharge.findById(req.params.id);

  if (!recharge || recharge.status !== "pending") {
    return res.status(400).json({ error: "Invalid request" });
  }

  const user = await User.findById(recharge.userId);

  user.plan = "pro";
  user.credits += 1000;

  await user.save();

  recharge.status = "approved";
  await recharge.save();

  res.json({ message: "Approved & upgraded" });
});

// =========================
// REJECT
// =========================
app.post('/admin/reject/:id', auth, adminOnly, async (req, res) => {
  const recharge = await Recharge.findById(req.params.id);

  recharge.status = "rejected";
  await recharge.save();

  res.json({ message: "Rejected" });
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
// 🚀 START
// =========================
app.listen(3000, () => {
  console.log("🚀 SERVER RUNNING: http://localhost:3000");
});