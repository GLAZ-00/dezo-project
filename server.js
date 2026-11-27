
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
  const { email, password, name, phone, ref } = req.body;
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email exists' });
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    email,
    password: hash,
    name,
    phone,
    referredBy: ref && users.some(u => u.id === ref) ? ref : null,
    refRewarded: false,
    balance: 0,
    euroBalance: 0,
    bonusBatches: [],
    dcHistory: [],
    treasure: [],
    extraSlots: 0,
    streakCount: 0,
    lastStreakDate: null,
    lastFreeSpinDate: null,
    created: Date.now()
  };
  users.push(user);
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, email, name, phone, balance: 0, euroBalance: 0 } });
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
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

app.post('/api/upload', auth, upload.array('photos', 6), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files' });
  const user = users.find(u => u.id === req.user.id);
  const isAdmin = user?.email === 'admin@dezo.gr' || user?.name?.trim().toUpperCase() === 'ALEX';
  const extraPhotos = req.body.isEdit === '1' ? 0 : Math.max(0, req.files.length - 3);
  if (!isAdmin && extraPhotos > 0) {
    if (!user || !spendDc(user, extraPhotos, `Επιπλέον φωτογραφίες (${extraPhotos}) / Extra photos (${extraPhotos}) (-${extraPhotos} DC)`)) {
      return res.status(400).json({ error: 'NOT_ENOUGH_DC_PHOTOS', needed: extraPhotos });
    }
  }
  try {
    const urls = [];

    for (const file of req.files) {
      const filename = `${uuidv4()}.jpg`;
            await sharp(file.buffer)
        .rotate()
        .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 55 })
        .toFile(path.join('uploads', filename));
      urls.push(`/uploads/${filename}`);
    }
    res.json({ urls });
  } catch (err) {
    res.status(500).json({ error: 'Compression failed' });
  }
});

function countUsedSlotsByCat(userId, userObj) {
  const now = Date.now();
  const thirtyDays = 30 * 86400000;
  const byCat = {};
  // Считаем все объявления за последние 30 дней (активные, проданные, в архиве, отклонённые)
  ads.filter(a => a.userId === userId && (now - (a.originalCreated || a.created || 0)) < thirtyDays)
     .forEach(a => { byCat[a.category] = (byCat[a.category] || 0) + 1; });
  // Плюс те, что пользователь удалил навсегда до истечения 30 дней
  if (userObj && Array.isArray(userObj.deletedSlotLogs)) {
    userObj.deletedSlotLogs = userObj.deletedSlotLogs.filter(s => (now - s.created) < thirtyDays);
    userObj.deletedSlotLogs.forEach(s => { byCat[s.category] = (byCat[s.category] || 0) + 1; });
  }
  return byCat;
}

// Create ad
app.post('/api/ads', auth, (req, res) => {
  // 1. Добавили subcategory в список — достаём её из посылки фронтенда
  const { title, description, price, category, subcategory, photos, city, phoneVisible } = req.body;
  const authorCheck = users.find(u => u.id === req.user.id);
  const isAdmin = authorCheck?.email === 'admin@dezo.gr' || authorCheck?.name?.trim().toUpperCase() === 'ALEX';
  if (!isAdmin && authorCheck) {
    const byCat = countUsedSlotsByCat(req.user.id, authorCheck);
    const inThisCat = byCat[category] || 0;
    if (inThisCat >= 2) {
      const usedExtra = Object.values(byCat).reduce((sum, cnt) => sum + Math.max(0, cnt - 2), 0);
      if (usedExtra >= (authorCheck.extraSlots || 0)) {
        return res.status(400).json({ error: 'NO_SLOTS' });
      }
    }
  }
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
    status: 'active',
    vip: false,
    promoted: false,
    views: 0
  };
    ads.push(ad);
  const author = users.find(u => u.id === req.user.id);
  if (author && author.referredBy && !author.refRewarded) {
    const inviter = users.find(u => u.id === author.referredBy);
    if (inviter) {
      author.refRewarded = true;
      grantBonusDc(inviter, 4, 'Μπόνους πρόσκλησης φίλου / Friend invite bonus (+4 DC)');
      grantBonusDc(author, 2, 'Μπόνους 1ης αγγελίας (πρόσκληση) / 1st listing invite bonus (+2 DC)');
    }
  }
  res.json(ad);
});

// Get ads
app.get('/api/ads', (req, res) => {
  const { category, q, vip } = req.query;
  ads.forEach(a => { if ((!a.status || a.status === 'active') && Date.now() - a.created >= 30 * 86400000) a.status = 'expired'; });
  let result = ads.filter(a => !a.status || a.status === 'active').sort((a, b) => b.created - a.created);
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
    const safe = { ...ad, ownerName: users.find(u => u.id === ad.userId)?.name || '', phone: ad.phoneVisible ? ad.phone : ad.phone.slice(0, 4) + '****' };
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
  ads.forEach(a => { if ((!a.status || a.status === 'active') && Date.now() - a.created >= 30 * 86400000) a.status = 'expired'; });
  res.json(ads.filter(a => a.userId === req.user.id));
});

app.post('/api/ads/:id/status', auth, (req, res) => {
  const ad = ads.find(a => a.id === req.params.id);
  const user = users.find(u => u.id === req.user.id);
  const isAdmin = user?.email === 'admin@dezo.gr' || user?.name?.trim().toUpperCase() === 'ALEX';
  if (!ad || (ad.userId !== req.user.id && !isAdmin)) return res.status(403).json({ error: 'Forbidden' });
  ad.status = req.body.status;
  if (req.body.status === 'active') ad.created = Date.now();
  res.json(ad);
});

app.delete('/api/ads/:id', auth, (req, res) => {
  const idx = ads.findIndex(a => a.id === req.params.id && a.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const ad = ads[idx];
  const createdTs = ad.originalCreated || ad.created || 0;
  if ((Date.now() - createdTs) < 30 * 86400000) {
    const u = users.find(x => x.id === req.user.id);
    if (u) {
      if (!Array.isArray(u.deletedSlotLogs)) u.deletedSlotLogs = [];
      u.deletedSlotLogs.push({ category: ad.category, created: createdTs });
    }
  }
  ads.splice(idx, 1);
  res.json({ ok: true });
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
    read: false,
    created: Date.now()
  };
  messages.push(msg);
  res.json(msg);
});

app.get('/api/messages/:adId', auth, (req, res) => {
  const adMessages = messages.filter(m => m.adId === req.params.adId && (m.from === req.user.id || m.to === req.user.id));
  adMessages.forEach(m => { if (m.to === req.user.id) m.read = true; });
  const enriched = adMessages.map(m => ({
    ...m,
    fromName: users.find(u => u.id === m.from)?.name || 'Χρήστης',
    toName: users.find(u => u.id === m.to)?.name || 'Χρήστης'
  }));
  res.json(enriched);
});
// Categories
app.get('/api/categories', (req, res) => res.json(categories));
let adminMessages = [];

app.post('/api/admin-messages', auth, (req, res) => {
  const { toUserId, text } = req.body;
  
  if (!text) return res.status(400).json({ error: 'Empty' });
  const sender = users.find(u => u.id === req.user.id);
  const msg = { id: Date.now().toString(), fromId: req.user.id, fromName: toUserId ? 'Διαχειριστής (ALEX)' : (sender?.name || 'Χρήστης'), toUserId: toUserId || 'ADMIN', text, read: false, createdAt: new Date() };
  adminMessages.push(msg);
  res.json(msg);
});

app.get('/api/admin-messages', auth, (req, res) => {
  adminMessages.forEach(m => {
    if (m.fromId !== req.user.id && (m.toUserId === 'ADMIN' || m.toUserId === req.user.id)) m.read = true;
  });
  res.json(adminMessages);
});

app.delete('/api/admin-messages/:id', auth, (req, res) => {
  adminMessages = adminMessages.filter(m => m.id !== req.params.id);
  res.json({ ok: true });
});

app.get('/api/unread', auth, (req, res) => {
  const unreadMsgs = messages.filter(m => m.to === req.user.id && !m.read).sort((a, b) => (a.created || 0) - (b.created || 0));
  const myAdSet = new Set(ads.filter(a => a.userId === req.user.id).map(a => a.id));
  const adIds = [...new Set(unreadMsgs.filter(m => myAdSet.has(m.adId)).map(m => m.adId))];
  const chatAdIds = [...new Set(unreadMsgs.filter(m => !myAdSet.has(m.adId)).map(m => m.adId))];
  const isAdmin = req.user.email === 'admin@dezo.gr' || req.user.name?.trim().toUpperCase() === 'ALEX';
  const adminMsgs = adminMessages.filter(m => !m.read && (isAdmin ? m.fromId !== req.user.id : m.toUserId === req.user.id));
  res.json({
    total: adIds.length + adminMsgs.length,
    adIds,
    chatAdIds,
    chatCount: chatAdIds.length,
    adminCount: adminMsgs.length
  });
});
// === LUCKY WHEEL, DAILY STREAK, 7-DAY EXPIRY & TREASURE CHEST ===
const SEVEN_DAYS_MS = 7 * 86400000;

function getAthensDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(d);
}

function syncUserRewards(user) {
  if (!user) return;
  if (typeof user.balance !== 'number') user.balance = 0;
  if (typeof user.euroBalance !== 'number') user.euroBalance = 0;
  if (!Array.isArray(user.bonusBatches)) user.bonusBatches = [];
  if (!Array.isArray(user.dcHistory)) user.dcHistory = [];
  if (!Array.isArray(user.treasure)) user.treasure = [];
  if (typeof user.extraSlots !== 'number') user.extraSlots = 0;
  if (typeof user.streakCount !== 'number') user.streakCount = 0;

  const now = Date.now();
  let expiredDc = 0;
  user.bonusBatches = user.bonusBatches.filter(b => {
    if (b.amount > 0 && b.expiresAt <= now) {
      expiredDc += b.amount;
      return false;
    }
    return b.amount > 0;
  });
  if (expiredDc > 0) {
    user.balance = Math.max(0, user.balance - expiredDc);
    user.dcHistory.unshift({ id: uuidv4(), type: 'expire', amount: -expiredDc, note: 'Λήξη 7 ημερών / 7-day bonus expired', date: now });
  }
  user.treasure = user.treasure.filter(t => t.expiresAt > now);
}

function grantBonusDc(user, amount, note) {
  syncUserRewards(user);
  const now = Date.now();
  user.balance += amount;
  user.bonusBatches.push({ id: uuidv4(), amount, expiresAt: now + SEVEN_DAYS_MS });
  user.dcHistory.unshift({ id: uuidv4(), type: 'bonus', amount, note, expiresAt: now + SEVEN_DAYS_MS, date: now });
}

function spendDc(user, cost, note) {
  syncUserRewards(user);
  if (user.balance < cost) return false;
  let rem = cost;
  user.bonusBatches.sort((a, b) => a.expiresAt - b.expiresAt);
  for (const b of user.bonusBatches) {
    if (rem <= 0) break;
    const take = Math.min(b.amount, rem);
    b.amount -= take;
    rem -= take;
  }
  user.bonusBatches = user.bonusBatches.filter(b => b.amount > 0);
  user.balance -= cost;
  user.dcHistory.unshift({ id: uuidv4(), type: 'spend', amount: -cost, note, date: Date.now() });
  return true;
}

const WHEEL_SECTORS_12 = [
  { index: 0, code: 'vip_21', label_el: 'VIP 3 εβδομάδες', label_en: 'VIP 3 Weeks', weight: 3 },
  { index: 1, code: 'retry', label_el: 'Δοκιμάστε ξανά', label_en: 'Try again', weight: 14 },
  { index: 2, code: 'dc_4', label_el: '4 DezoCoin', label_en: '4 DezoCoin', weight: 7 },
  { index: 3, code: 'retry', label_el: 'Δοκιμάστε ξανά', label_en: 'Try again', weight: 14 },
  { index: 4, code: 'promo_5', label_el: 'Προώθηση 5 ημερών', label_en: '5-Day Promotion', weight: 6 },
  { index: 5, code: 'retry', label_el: 'Δοκιμάστε ξανά', label_en: 'Try again', weight: 14 },
  { index: 6, code: 'dc_2', label_el: '2 DezoCoin', label_en: '2 DezoCoin', weight: 15 },
  { index: 7, code: 'retry', label_el: 'Δοκιμάστε ξανά', label_en: 'Try again', weight: 14 },
  { index: 8, code: 'promo_3', label_el: 'Προώθηση 3 ημερών', label_en: '3-Day Promotion', weight: 9 },
  { index: 9, code: 'retry', label_el: 'Δοκιμάστε ξανά', label_en: 'Try again', weight: 14 },
  { index: 10, code: 'slot_1', label_el: '+1 Θέση αγγελίας', label_en: '+1 Listing Slot', weight: 5 },
  { index: 11, code: 'retry', label_el: 'Δοκιμάστε ξανά', label_en: 'Try again', weight: 14 }
];

app.get('/api/wheel/state', auth, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  syncUserRewards(user);
  const today = getAthensDateStr(0);
  const yesterday = getAthensDateStr(-1);
  if (user.lastStreakDate && user.lastStreakDate !== today && user.lastStreakDate !== yesterday) {
    user.streakCount = 0;
  }
  res.json({
    balance: user.balance,
    euroBalance: user.euroBalance,
    freeSpinAvailable: user.lastFreeSpinDate !== today,
    dailyCoinAvailable: user.lastStreakDate !== today,
    streakCount: user.streakCount,
    treasure: user.treasure,
    dcHistory: user.dcHistory,
    extraSlots: user.extraSlots
  });
});

app.post('/api/wheel/daily-coin', auth, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  syncUserRewards(user);
  const today = getAthensDateStr(0);
  const yesterday = getAthensDateStr(-1);
  if (user.lastStreakDate === today) {
    return res.status(400).json({ error: 'Already claimed today' });
  }
  user.streakCount = (user.lastStreakDate === yesterday) ? (user.streakCount % 28) + 1 : 1;
  user.lastStreakDate = today;

  let reward = 1;
  if (user.streakCount === 7) reward = 2;
  else if (user.streakCount === 14) reward = 3;
  else if (user.streakCount === 21) reward = 4;
  else if (user.streakCount === 28) reward = 5;

  grantBonusDc(user, reward, `Καθημερινό μπόνους Ημέρα ${user.streakCount}/28 / Daily bonus Day ${user.streakCount}/28`);
  res.json({
    ok: true,
    reward,
    streakCount: user.streakCount,
    balance: user.balance,
    dcHistory: user.dcHistory
  });
});

app.post('/api/wheel/spin', auth, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  syncUserRewards(user);
  const mode = req.body.mode === 'paid' ? 'paid' : 'free';
  const today = getAthensDateStr(0);

  if (mode === 'free') {
    if (user.lastFreeSpinDate === today) return res.status(400).json({ error: 'Free spin already used today' });
    user.lastFreeSpinDate = today;
  } else {
    if (!spendDc(user, 1, 'Περιστροφή Τροχού / Lucky Wheel spin (-1 DC)')) {
      return res.status(400).json({ error: 'Not enough DezoCoin' });
    }
  }

  const totalWeight = WHEEL_SECTORS_12.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * totalWeight;
  let picked = WHEEL_SECTORS_12[0];
  for (const s of WHEEL_SECTORS_12) {
    r -= s.weight;
    if (r <= 0) { picked = s; break; }
  }

  const now = Date.now();
  if (picked.code === 'dc_2') {
    grantBonusDc(user, 2, 'Κέρδος Τροχού / Wheel prize (+2 DC)');
  } else if (picked.code === 'dc_4') {
    grantBonusDc(user, 4, 'Κέρδος Τροχού / Wheel prize (+4 DC)');
  } else if (picked.code !== 'retry') {
    user.treasure.push({
      id: uuidv4(),
      code: picked.code,
      label_el: picked.label_el,
      label_en: picked.label_en,
      createdAt: now,
      expiresAt: now + SEVEN_DAYS_MS
    });
  }

  res.json({
    ok: true,
    sector: picked,
    balance: user.balance,
    freeSpinAvailable: user.lastFreeSpinDate !== today,
    treasure: user.treasure,
    dcHistory: user.dcHistory
  });
});

app.post('/api/treasure/use', auth, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  syncUserRewards(user);
  const { itemId, adId } = req.body;
  const idx = user.treasure.findIndex(t => t.id === itemId);
  if (idx === -1) return res.status(404).json({ error: 'Reward not found or expired' });
  const item = user.treasure[idx];

  if (item.code === 'slot_1') {
    user.extraSlots = (user.extraSlots || 0) + 1;
    user.treasure.splice(idx, 1);
    return res.json({ ok: true, extraSlots: user.extraSlots, treasure: user.treasure });
  }

  const ad = ads.find(a => a.id === adId && a.userId === req.user.id);
  if (!ad) return res.status(400).json({ error: 'Select an active ad' });

  const now = Date.now();
  if (item.code === 'vip_21') {
    ad.vip = true;
    ad.vipUntil = now + 21 * 86400000;
  } else if (item.code === 'promo_5') {
    ad.promoted = true;
    ad.promotedUntil = now + 5 * 86400000;
    ad.created = now;
  } else if (item.code === 'promo_3') {
    ad.promoted = true;
    ad.promotedUntil = now + 3 * 86400000;
    ad.created = now;
  }
  user.treasure.splice(idx, 1);
  res.json({ ok: true, ad, treasure: user.treasure });
});
// Serve index.html from public
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ΔΕΖΟ server running on http://localhost:${PORT}`);
});
