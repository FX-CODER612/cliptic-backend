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

// ✅ CORS – Allow all origins (for development; restrict in production if needed)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Create uploads folder if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// ✅ Keep‑alive / health check endpoint (Render will ping this)
app.get("/", (req, res) => {
  res.send("🚀 Cliptic Backend is LIVE and working!");
});

// ☁️ Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// 🔌 MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1);
  });

// =========================
// MODELS
// =========================
const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  credits: { type: Number, default: 30 },
  plan: { type: String, default: "free" },
  role: { type: String, default: "user" }   // 'user' or 'admin'
}));

const Clip = mongoose.model('Clip', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  file: { type: String, required: true },
  score: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

const Recharge = mongoose.model('Recharge', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['bank', 'crypto'], required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
}));

// =========================
// MIDDLEWARE
// =========================
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token provided" });

  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

// =========================
// AUTH ROUTES
// =========================
app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);
    await User.create({ email, password: hashed });

    res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// =========================
// USER ROUTES
// =========================
app.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      email: user.email,
      credits: user.credits,
      plan: user.plan,
      role: user.role
    });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// =========================
// UPLOAD CONFIG
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
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn("Failed to delete file:", filePath, err);
  }
}

// =========================
// CLIP GENERATION ROUTES
// =========================
app.post('/auto-cut', auth, upload.single('video'), async (req, res) => {
  let inputPath, outputPath;

  try {
    if (!req.file) return res.status(400).json({ error: "No video file uploaded" });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.credits < 5) {
      return res.status(400).json({ error: "Insufficient credits. You need at least 5 credits." });
    }

    const duration = parseInt(req.body.duration) || 10;
    if (duration <= 0 || duration > 60) {
      return res.status(400).json({ error: "Duration must be between 1 and 60 seconds" });
    }

    // Deduct credits
    user.credits -= 5;
    await user.save();

    inputPath = req.file.path;
    outputPath = path.join('uploads', `clip-${Date.now()}.mp4`);

    // Cut video using FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setDuration(duration)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(outputPath, {
      resource_type: "video",
      folder: "cliptic_clips"
    });

    // Save clip record
    const clip = await Clip.create({
      userId: user._id,
      file: result.secure_url,
      score: getViralScore()
    });

    res.json({
      message: "Clip created successfully",
      clip: {
        id: clip._id,
        url: clip.file,
        score: clip.score
      },
      remainingCredits: user.credits
    });

  } catch (err) {
    console.error("Auto-cut error:", err);
    res.status(500).json({ error: "Video processing failed. Please try again." });
  } finally {
    safeDelete(inputPath);
    safeDelete(outputPath);
  }
});

app.get('/my-clips', auth, async (req, res) => {
  try {
    const clips = await Clip.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .select('file score createdAt');
    res.json(clips);
  } catch (err) {
    console.error("Fetch clips error:", err);
    res.status(500).json({ error: "Failed to fetch clips" });
  }
});

// Video to Animation (placeholder – can be enhanced later)
app.post('/video-to-animation', auth, upload.single('video'), async (req, res) => {
  let inputPath;

  try {
    if (!req.file) return res.status(400).json({ error: "No video file uploaded" });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.credits < 5) {
      return res.status(400).json({ error: "Insufficient credits" });
    }

    user.credits -= 5;
    await user.save();

    inputPath = req.file.path;

    // For now, just upload the same video (you can add FFmpeg filters later)
    const result = await cloudinary.uploader.upload(inputPath, {
      resource_type: "video",
      folder: "cliptic_animations"
    });

    await Clip.create({
      userId: user._id,
      file: result.secure_url,
      score: getViralScore()
    });

    res.json({
      message: "Animation created",
      url: result.secure_url,
      remainingCredits: user.credits
    });

  } catch (err) {
    console.error("Animation error:", err);
    res.status(500).json({ error: "Animation conversion failed" });
  } finally {
    safeDelete(inputPath);
  }
});

// =========================
// RECHARGE ROUTES
// =========================
app.post('/request-recharge', auth, async (req, res) => {
  try {
    const { type } = req.body;
    if (!type || !['bank', 'crypto'].includes(type)) {
      return res.status(400).json({ error: "Invalid recharge type" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    await Recharge.create({
      userId: user._id,
      type
    });

    res.json({ message: "Recharge request submitted. Admin will review shortly." });
  } catch (err) {
    console.error("Recharge request error:", err);
    res.status(500).json({ error: "Failed to submit request" });
  }
});

// =========================
// ADMIN ROUTES
// =========================
app.get('/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find({}, 'email credits plan role createdAt').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.post('/admin/give-credits/:userId', auth, adminOnly, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Valid positive amount required" });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.credits += Number(amount);
    await user.save();

    res.json({ message: `Added ${amount} credits to ${user.email}. New balance: ${user.credits}` });
  } catch (err) {
    console.error("Give credits error:", err);
    res.status(500).json({ error: "Failed to give credits" });
  }
});

app.get('/admin/recharges', auth, adminOnly, async (req, res) => {
  try {
    const recharges = await Recharge.find()
      .populate('userId', 'email')
      .sort({ createdAt: -1 });
    res.json(recharges);
  } catch (err) {
    console.error("Admin recharges error:", err);
    res.status(500).json({ error: "Failed to fetch recharge requests" });
  }
});

app.post('/admin/approve/:rechargeId', auth, adminOnly, async (req, res) => {
  try {
    const recharge = await Recharge.findById(req.params.rechargeId);
    if (!recharge) return res.status(404).json({ error: "Recharge request not found" });
    if (recharge.status !== 'pending') {
      return res.status(400).json({ error: "Request already processed" });
    }

    const user = await User.findById(recharge.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Define credit amounts per recharge type
    const creditAmounts = {
      bank: 100,
      crypto: 200
    };
    const creditsToAdd = creditAmounts[recharge.type] || 50;

    user.credits += creditsToAdd;
    await user.save();

    recharge.status = 'approved';
    await recharge.save();

    res.json({ message: `Recharge approved. Added ${creditsToAdd} credits to user.` });
  } catch (err) {
    console.error("Approve recharge error:", err);
    res.status(500).json({ error: "Approval failed" });
  }
});

app.post('/admin/reject/:rechargeId', auth, adminOnly, async (req, res) => {
  try {
    const recharge = await Recharge.findById(req.params.rechargeId);
    if (!recharge) return res.status(404).json({ error: "Recharge request not found" });
    if (recharge.status !== 'pending') {
      return res.status(400).json({ error: "Request already processed" });
    }

    recharge.status = 'rejected';
    await recharge.save();

    res.json({ message: "Recharge request rejected." });
  } catch (err) {
    console.error("Reject recharge error:", err);
    res.status(500).json({ error: "Rejection failed" });
  }
});

// =========================
// GLOBAL ERROR HANDLER
// =========================
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  res.status(500).json({ error: "Something went wrong on the server." });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Cliptic server running on port ${PORT}`);
});