
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'dezo-secret-key-change-in-production';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure directories
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('public')) fs.mkdirSync('public');

// In-memory stores (demo only)
let users = [];
let ads = [];
let messages = [];

const categories = [
  { id: 'home', name_el: 'Σπίτι & Κήπος', name_en: 'Home & Garden' },
  { id: 'electronics', name_el: 'Ηλεκτρονικά', name_en: 'Electronics' },
  { id: 'auto', name_el: 'Αυτοκίνητα', name_en: 'Cars' },
  { id: 'fashion', name_el: 'Μόδα & Στυλ', name_en: 'Fashion & Style' },
  { id: 'jobs', name_el: 'Εργασία', name_en: 'Jobs' },
  { id: 'realestate', name_el: 'Ακίνητα', name_en: 'Real Estate' },
  { id: 'kids', name_el: 'Παιδικός κόσμος', name_en: 'Kids' },
  { id: 'services', name_el: 'Υπηρεσίες', name_en: 'Services' }
];

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, name, phone } = req.body;
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email exists' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), email, password: hash, name, phone, created: Date.now() };
  users.push(user);
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, email, name, phone } });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, phone: user.phone } });
});

// Upload middleware with compression
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const filename = `${uuidv4()}.jpg`;
    await sharp(req.file.buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(path.join('uploads', filename));
    res.json({ url: `/uploads/${filename}` });
  } catch (err) {
    res.status(500).json({ error: 'Compression failed' });
  }
});

// Create ad
app.post('/api/ads', auth, (req, res) => {
  // 1. Добавили subcategory в список — достаём её из посылки фронтенда
  const { title, description, price, category, subcategory, photos, city, phoneVisible } = req.body;
  const ad = {
    id: uuidv4(),
    userId: req.user.id,
    title,
    description,
    price: Number(price),
    category,
    subcategory: subcategory || 'Άλλο',
    photos: Array.isArray(photos) ? photos : (photos ? [photos] : []),
    city: city || 'Αθήνα',
    phone: users.find(u => u.id === req.user.id)?.phone || '',
    phoneVisible: !!phoneVisible,
    created: Date.now(),
    vip: false,
    promoted: false,
    views: 0
  };
  ads.push(ad);
  res.json(ad);
});

// Get ads
app.get('/api/ads', (req, res) => {
  const { category, q, vip } = req.query;
  let result = [...ads].sort((a, b) => b.created - a.created);
  if (category) result = result.filter(a => a.category === category);
  if (q) result = result.filter(a => a.title.toLowerCase().includes(q.toLowerCase()) || a.description.toLowerCase().includes(q.toLowerCase()));
  if (vip === '1') result = result.filter(a => a.vip);
  res.json(result);
});

app.get('/api/ads/:id/phone', (req, res) => {
  const ad = ads.find(a => a.id === req.params.id);
  if (!ad) return res.status(404).json({ error: 'Ad not found' });
  const owner = users.find(u => u.id === ad.userId);
  res.json({ phone: owner ? owner.phone : ad.phone || 'Нет номера' });
});

// Get single ad
app.get('/api/ads/:id', (req, res) => {
  const ad = ads.find(a => a.id === req.params.id);
  if (!ad) return res.status(404).json({ error: 'Not found' });
  ad.views++;
  // Hide full phone unless revealed flag (client handles click)
  const safe = { ...ad, phone: ad.phoneVisible ? ad.phone : ad.phone.slice(0, 4) + '****' };
  res.json(safe);
});

// Promote ad (mock)
app.post('/api/ads/:id/promote', auth, (req, res) => {
  const ad = ads.find(a => a.id === req.params.id && a.userId === req.user.id);
  if (!ad) return res.status(404).json({ error: 'Not found' });
  ad.vip = true;
  ad.promoted = true;
  res.json(ad);
});

// My ads
app.get('/api/my-ads', auth, (req, res) => {
  res.json(ads.filter(a => a.userId === req.user.id));
});

// Messages
app.post('/api/messages', auth, (req, res) => {
  const { adId, text, toUserId } = req.body;
  const msg = {
    id: uuidv4(),
    adId,
    from: req.user.id,
    to: toUserId,
    text,
    created: Date.now()
  };
  messages.push(msg);
  res.json(msg);
});

app.get('/api/messages/:adId', auth, (req, res) => {
  const adMessages = messages.filter(m => m.adId === req.params.adId && (m.from === req.user.id || m.to === req.user.id));
  res.json(adMessages);
});

// Categories
app.get('/api/categories', (req, res) => res.json(categories));

// Serve index.html from public
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ΔΕΖΟ server running on http://localhost:${PORT}`);
});
