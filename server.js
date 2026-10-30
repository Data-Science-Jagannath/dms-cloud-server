const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const MONGO_URL = process.env.MONGODB_URI || "mongodb://localhost:27017/DMS";
const PORT = process.env.PORT || 3000;

let dbClient = null;

async function ensureIndexes() {
  if (!dbClient) return;
  try {
    const db = dbClient.db("DMS");
    // Wholesale Invoice collection indexes
    await db.collection("invoices").createIndex({ customerName: 1 });
    await db.collection("invoices").createIndex({ date: -1 });
    await db.collection("invoices").createIndex({ "newItems.name": 1 });
    await db.collection("invoices").createIndex({ "scrapItems.name": 1 });
    
    // Retail Invoice collection indexes
    await db.collection("retail_invoices").createIndex({ customerName: 1 });
    await db.collection("retail_invoices").createIndex({ customerPhone: 1 });
    await db.collection("retail_invoices").createIndex({ date: -1 });
    await db.collection("retail_invoices").createIndex({ "newItems.name": 1 });
    await db.collection("retail_invoices").createIndex({ "scrapItems.name": 1 });
    await db.collection("retail_invoices").createIndex({ "stampData.cycleId": 1 });
    await db.collection("retail_invoices").createIndex({ invoiceNo: 1 });
    
    // Wholesale Items collection index for fast rate lookups
    await db.collection("items").createIndex({ name: 1, type: 1 }, { unique: true });

    // Separate Retail Items collection index
    await db.collection("retail_items").createIndex({ name: 1, type: 1 }, { unique: true });

    // Customer Stamps Loyalty Ledger indexes
    await db.collection("customer_stamps").createIndex({ customerPhone: 1 }, { unique: true });
    await db.collection("customer_stamps").createIndex({ customerName: 1 });
    
    console.log("🚀 [DB] Performance indexes verified");
  } catch (err) {
    console.error("❌ [DB] Index error:", err);
  }
}

const DEFAULT_STAMP_SETTINGS = {
  targetStamps: 5,
  minInvoiceAmount: 200,
  specialKeywords: ["ss", "stainless steel", "aluminium", "aluminum", "al", "brass", "bronze"],
  specialRewardPercent: 2,
  standardRewardPercent: 5,
  roundingIncrement: 10,
  roundingMethod: "floor",
  cooldownHours: 6,
  isEnabled: true,
  giftTiers: [
    { id: "tier_1", minValue: 20, maxValue: 49, giftTitle: "SS Dessert Spoon / Knife", description: "Stainless steel spoon or knife" },
    { id: "tier_2", minValue: 50, maxValue: 99, giftTitle: "SS Peeler / Vegetable Cutter / Small Bowl", description: "Essential kitchen tool or small bowl" },
    { id: "tier_3", minValue: 100, maxValue: 199, giftTitle: "SS Serving Tiffin / Deep Bowl", description: "Stainless steel serving bowl or 2-tier tiffin" },
    { id: "tier_4", minValue: 200, maxValue: 499, giftTitle: "Premium SS Kadai / Saucepan", description: "Heavy gauge kadai or saucepan" },
    { id: "tier_5", minValue: 500, maxValue: 999999, giftTitle: "Cookware Combo / Premium Appliance", description: "Premium cookware combo set" }
  ]
};

async function ensureStampSettings() {
  if (!dbClient) return DEFAULT_STAMP_SETTINGS;
  try {
    const db = dbClient.db("DMS");
    let settings = await db.collection("stamp_settings").findOne({});
    if (!settings) {
      const initial = {
        ...DEFAULT_STAMP_SETTINGS,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await db.collection("stamp_settings").insertOne(initial);
      console.log("ℹ️ [DB] Initialized default stamp_settings with 5-stamp rules and gift tiers");
      return initial;
    }
    return settings;
  } catch (err) {
    console.error("❌ [DB] Stamp settings error:", err);
    return DEFAULT_STAMP_SETTINGS;
  }
}

async function migrateRetailItemsCollection() {
  if (!dbClient) return;
  try {
    const db = dbClient.db("DMS");
    const count = await db.collection("retail_items").countDocuments();
    if (count === 0) {
      console.log("⏳ [DB] Migrating items to separate retail_items collection...");
      const wholesaleItems = await db.collection("items").find({}).toArray();
      if (wholesaleItems.length > 0) {
        const bulkOps = wholesaleItems.map(item => ({
          updateOne: {
            filter: { name: item.name, type: item.type || 'new' },
            update: {
              $set: {
                rate: Number(item.retail_rate ?? item.rate) || 0,
                cost_price: Number(item.cost_price) || 0,
                rewardPercent: null,
                category: item.category || '',
                updatedAt: new Date()
              },
              $setOnInsert: { createdAt: new Date() }
            },
            upsert: true
          }
        }));
        await db.collection("retail_items").bulkWrite(bulkOps, { ordered: false });
        console.log(`✅ [DB] Successfully initialized retail_items collection with ${wholesaleItems.length} items`);
      }
    }
  } catch (err) {
    console.error("❌ [DB] retail_items migration error:", err);
  }
}

function isSpecialMetalItem(itemName, keywords) {
  if (!itemName || typeof itemName !== 'string') return false;
  const lower = itemName.toLowerCase().trim();
  const list = (keywords && Array.isArray(keywords) && keywords.length > 0) ? keywords : DEFAULT_STAMP_SETTINGS.specialKeywords;
  return list.some(kw => {
    const cleanKw = kw.toLowerCase().trim();
    if (!cleanKw) return false;
    const regex = new RegExp(`(^|\\b|\\s|_)${cleanKw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\b|\\s|_|$)`, 'i');
    return regex.test(lower) || lower.includes(cleanKw);
  });
}

function matchGiftTier(accumulatedRewardValue, giftTiers) {
  const tiers = (giftTiers && Array.isArray(giftTiers) && giftTiers.length > 0) ? giftTiers : DEFAULT_STAMP_SETTINGS.giftTiers;
  const sorted = [...tiers].sort((a, b) => (Number(a.minValue) || 0) - (Number(b.minValue) || 0));
  let matched = null;
  for (const tier of sorted) {
    const min = Number(tier.minValue) || 0;
    const max = Number(tier.maxValue) || Infinity;
    if (accumulatedRewardValue >= min && accumulatedRewardValue <= max) {
      matched = tier;
    }
  }
  if (!matched && sorted.length > 0 && accumulatedRewardValue > (Number(sorted[sorted.length - 1].minValue) || 0)) {
    matched = sorted[sorted.length - 1];
  }
  return matched ? matched.giftTitle : `Gift worth ₹${accumulatedRewardValue}`;
}

async function migrateItemsFromInvoices() {
  if (!dbClient) return;
  try {
    const db = dbClient.db("DMS");
    const itemsCount = await db.collection("items").countDocuments();
    if (itemsCount === 0) {
      console.log("⏳ [DB] Migrating historical items to new items collection...");
      
      const newItemsAgg = await db.collection("invoices").aggregate([
        { $sort: { date: 1, createdAt: 1 } },
        { $unwind: "$newItems" },
        { $match: { "newItems.name": { $exists: true, $ne: "" } } },
        { $group: { _id: "$newItems.name", rate: { $last: "$newItems.rate" } } }
      ]).toArray();

      const scrapItemsAgg = await db.collection("invoices").aggregate([
        { $sort: { date: 1, createdAt: 1 } },
        { $unwind: "$scrapItems" },
        { $match: { "scrapItems.name": { $exists: true, $ne: "" } } },
        { $group: { _id: "$scrapItems.name", rate: { $last: "$scrapItems.rate" } } }
      ]).toArray();

      const bulkOps = [];
      newItemsAgg.forEach(item => {
        if (item._id) {
          bulkOps.push({
            updateOne: {
              filter: { name: item._id, type: 'new' },
              update: { $set: { rate: Number(item.rate) || 0, updatedAt: new Date() } },
              upsert: true
            }
          });
        }
      });

      scrapItemsAgg.forEach(item => {
        if (item._id) {
          bulkOps.push({
            updateOne: {
              filter: { name: item._id, type: 'scrap' },
              update: { $set: { rate: Number(item.rate) || 0, updatedAt: new Date() } },
              upsert: true
            }
          });
        }
      });

      if (bulkOps.length > 0) {
        await db.collection("items").bulkWrite(bulkOps, { ordered: false });
        console.log(`✅ [DB] Successfully migrated ${bulkOps.length} historical items to new collection`);
      }
    }
  } catch (err) {
    console.error("❌ [DB] Migration error:", err);
  }
}

async function migrateRetailRateAndCostPrice() {
  if (!dbClient) return;
  try {
    const db = dbClient.db("DMS");
    const sample = await db.collection("items").findOne({ retail_rate: { $exists: true } });
    if (sample) return;

    console.log("⏳ [DB] Initializing retail_rate and cost_price fields on items collection...");
    const { modifiedCount } = await db.collection("items").updateMany(
      { retail_rate: { $exists: false } },
      [{
        $set: {
          retail_rate: "$rate",
          cost_price: 0
        }
      }]
    );
    console.log(`✅ [DB] Added retail_rate & cost_price to ${modifiedCount} items`);
  } catch (err) {
    console.error("❌ [DB] retail_rate migration error:", err);
  }
}

async function connectToMongo() {
  try {
    const client = new MongoClient(MONGO_URL, { 
      connectTimeoutMS: 15000, 
      serverSelectionTimeoutMS: 15000 
    });
    await client.connect();
    dbClient = client;
    console.log("✅ [DB] Connected to MongoDB Atlas");
    await ensureIndexes();
    await migrateItemsFromInvoices();
    await migrateRetailRateAndCostPrice();
    await migrateRetailItemsCollection();
    await ensureStampSettings();
  } catch (error) {
    console.warn("⚠️ [DB] MongoDB Offline (ECONNREFUSED / Timeout).", error.message);
    dbClient = null;
  }
}

const app = express();

// Full CORS support for Mobile & Web clients
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"]
}));

app.use(express.json());

// Background connection attempt
connectToMongo();

// Request logger
app.use((req, res, next) => {
  if (req.url.startsWith('/api')) {
    console.log(`📡 [API Request] ${req.method} ${req.url}`);
  }
  next();
});

// Root Health Check for Cloud Providers (Render, Railway, UptimeRobot)
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "DMS Estimate Cloud Server",
    database: dbClient ? "connected" : "disconnected",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/ping", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Dashboard Items
app.get("/api/dashboard-items", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const allItems = await db.collection("items").find({}).sort({ name: 1 }).toArray();
    
    const newItems = allItems.filter(i => i.type === 'new').map(i => ({ 
      name: i.name, 
      rate: i.rate, 
      retail_rate: i.retail_rate ?? i.rate, 
      cost_price: i.cost_price ?? 0 
    }));
    const scrapItems = allItems.filter(i => i.type === 'scrap').map(i => ({ 
      name: i.name, 
      rate: i.rate, 
      retail_rate: i.retail_rate ?? i.rate, 
      cost_price: i.cost_price ?? 0 
    }));

    res.json({ newItems, scrapItems });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Customers list
app.get("/api/customers", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const [wholesaleNames, retailNames] = await Promise.all([
      db.collection("invoices").distinct("customerName"),
      db.collection("retail_invoices").distinct("customerName")
    ]);
    const allNames = [...new Set([...wholesaleNames, ...retailNames])];
    const sorted = allNames.filter(n => typeof n === 'string' && n.trim() !== '').sort();
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Customer Lookup (name & phone for auto-suggest)
app.get("/api/customer-lookup", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const [stampsList, retailInvoices] = await Promise.all([
      db.collection("customer_stamps").find({}, { projection: { customerName: 1, customerPhone: 1, _id: 0 } }).toArray(),
      db.collection("retail_invoices").find({ customerPhone: { $exists: true, $ne: "" } }, { projection: { customerName: 1, customerPhone: 1, _id: 0 } }).sort({ date: -1 }).limit(200).toArray()
    ]);
    const map = new Map();
    [...stampsList, ...retailInvoices].forEach(item => {
      const phone = String(item.customerPhone || '').replace(/\D/g, '');
      if (phone && phone.length >= 10 && !map.has(phone)) {
        map.set(phone, { phone, name: item.customerName || '' });
      }
    });
    res.json(Array.from(map.values()));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stamp Settings Endpoints
app.get("/api/stamp-settings", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const settings = await ensureStampSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/stamp-settings", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const {
      targetStamps,
      minInvoiceAmount,
      specialKeywords,
      specialRewardPercent,
      standardRewardPercent,
      roundingIncrement,
      roundingMethod,
      cooldownHours,
      giftTiers,
      isEnabled
    } = req.body;

    const updatePayload = {
      targetStamps: Math.max(1, Number(targetStamps) || 5),
      minInvoiceAmount: Math.max(0, Number(minInvoiceAmount) || 200),
      cooldownHours: Number.isFinite(Number(cooldownHours)) ? Math.max(0, Number(cooldownHours)) : 6,
      specialKeywords: Array.isArray(specialKeywords) 
        ? specialKeywords.map(k => String(k).trim().toLowerCase()).filter(Boolean)
        : DEFAULT_STAMP_SETTINGS.specialKeywords,
      specialRewardPercent: Number(specialRewardPercent) || 2,
      standardRewardPercent: Number(standardRewardPercent) || 5,
      roundingIncrement: Number(roundingIncrement) || 10,
      roundingMethod: roundingMethod || 'floor',
      giftTiers: Array.isArray(giftTiers) ? giftTiers : DEFAULT_STAMP_SETTINGS.giftTiers,
      isEnabled: typeof isEnabled === 'boolean' ? isEnabled : true,
      updatedAt: new Date()
    };

    await db.collection("stamp_settings").updateOne(
      {},
      { $set: updatePayload },
      { upsert: true }
    );
    res.json({ success: true, settings: updatePayload });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retail Items (Separate catalog for retail estimates)
app.get("/api/retail-items", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const allItems = await db.collection("retail_items").find({}).sort({ name: 1 }).toArray();
    
    const newItems = allItems.filter(i => i.type === 'new').map(i => ({ 
      _id: i._id,
      name: i.name, 
      rate: Number(i.rate) || 0, 
      retail_rate: Number(i.rate) || 0, 
      cost_price: Number(i.cost_price) || 0,
      gst: (i.gst !== undefined && i.gst !== null) ? Number(i.gst) : 0,
      rewardPercent: (i.rewardPercent !== undefined && i.rewardPercent !== null) ? Number(i.rewardPercent) : null,
      category: i.category || ''
    }));
    const scrapItems = allItems.filter(i => i.type === 'scrap').map(i => ({ 
      _id: i._id,
      name: i.name, 
      rate: Number(i.rate) || 0, 
      retail_rate: Number(i.rate) || 0, 
      cost_price: Number(i.cost_price) || 0,
      gst: (i.gst !== undefined && i.gst !== null) ? Number(i.gst) : 0,
      rewardPercent: (i.rewardPercent !== undefined && i.rewardPercent !== null) ? Number(i.rewardPercent) : null,
      category: i.category || ''
    }));

    res.json({ newItems, scrapItems });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/retail-items", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const { id, name, type, rate, cost_price, gst, rewardPercent, category } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Item name is required" });
    
    const payload = {
      name: name.trim(),
      type: type === 'scrap' ? 'scrap' : 'new',
      rate: Number(rate) || 0,
      cost_price: Number(cost_price) || 0,
      gst: (gst !== undefined && gst !== null && gst !== '') ? Number(gst) : 0,
      rewardPercent: (rewardPercent !== undefined && rewardPercent !== null && rewardPercent !== '') ? Number(rewardPercent) : null,
      category: category ? String(category).trim() : '',
      updatedAt: new Date()
    };

    if (id) {
      await db.collection("retail_items").updateOne(
        { _id: new ObjectId(id) },
        { $set: payload }
      );
      res.json({ success: true, id });
    } else {
      const result = await db.collection("retail_items").updateOne(
        { name: payload.name, type: payload.type },
        { $set: payload, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      res.json({ success: true, id: result.upsertedId || id });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/retail-items/:id", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    await db.collection("retail_items").deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Customer Stamp Status by Mobile Number (for external Web App & Mobile App)
app.get("/api/customer-stamps/:phone", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ error: "Invalid mobile number" });
    }
    const stampSettings = await ensureStampSettings();
    const cooldownHours = Number(stampSettings.cooldownHours ?? 6);

    const doc = await db.collection("customer_stamps").findOne({ customerPhone: cleanPhone });

    let lastStampedAt = doc?.lastStampedAt || null;
    if (!lastStampedAt && doc?.activeCycle?.invoices?.length > 0) {
      const invs = doc.activeCycle.invoices;
      lastStampedAt = invs[invs.length - 1].stampedAt;
    }

    let inCooldown = false;
    let cooldownRemainingMinutes = 0;
    if (lastStampedAt) {
      const elapsedMs = Date.now() - new Date(lastStampedAt).getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);
      if (elapsedHours < cooldownHours) {
        inCooldown = true;
        cooldownRemainingMinutes = Math.max(1, Math.round((cooldownHours - elapsedHours) * 60));
      }
    }

    if (!doc) {
      return res.json({
        exists: false,
        customerPhone: cleanPhone,
        customerName: "",
        lastStampedAt: null,
        inCooldown: false,
        cooldownRemainingMinutes: 0,
        cooldownHours,
        activeCycle: {
          cycleId: new ObjectId().toString(),
          cycleNumber: 1,
          currentStamps: 0,
          targetStamps: 5,
          accumulatedRewardValue: 0,
          status: 'active',
          invoices: []
        },
        completedCycles: [],
        totalLifetimeStamps: 0,
        totalLifetimeRewardValue: 0
      });
    }
    res.json({
      exists: true,
      customerPhone: doc.customerPhone,
      customerName: doc.customerName,
      lastStampedAt,
      inCooldown,
      cooldownRemainingMinutes,
      cooldownHours,
      activeCycle: doc.activeCycle || {
        cycleId: new ObjectId().toString(),
        cycleNumber: (doc.completedCycles?.length || 0) + 1,
        currentStamps: 0,
        targetStamps: 5,
        accumulatedRewardValue: 0,
        status: 'active',
        invoices: []
      },
      completedCycles: doc.completedCycles || [],
      totalLifetimeStamps: doc.totalLifetimeStamps || 0,
      totalLifetimeRewardValue: doc.totalLifetimeRewardValue || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// In-memory OTP storage for Cloud Server: phone -> { otp, expiresAt }
const cloudOtpStore = new Map();

// Send OTP via WhatsApp
app.post("/api/rewards/otp/send", async (req, res) => {
  try {
    const rawPhone = String(req.body.phone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: "Invalid 10-digit mobile number" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + (5 * 60 * 1000);
    cloudOtpStore.set(cleanPhone, { otp, expiresAt });

    const msg = `Namaste from Durga Metal Shop! Your loyalty verification code is: *${otp}*.\n\nValid for 5 minutes to access your 5-stamp rewards pass.`;
    const storeWa = process.env.WHATSAPP_PHONE_NUMBER || "9937009855";
    const waLink = `https://wa.me/91${storeWa}?text=${encodeURIComponent(msg)}`;

    let smsSent = false;
    let smsError = null;
    const fast2smsKey = process.env.FAST2SMS_API_KEY;
    if (fast2smsKey) {
      try {
        const fastResp = await fetch("https://www.fast2sms.com/dev/bulkV2", {
          method: "POST",
          headers: {
            "authorization": fast2smsKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            route: "otp",
            variables_values: otp,
            numbers: cleanPhone
          })
        });
        const fastData = await fastResp.json();
        if (fastData && fastData.return === true) {
          smsSent = true;
        } else {
          smsError = fastData.message || JSON.stringify(fastData);
        }
      } catch (err) {
        smsError = err.message;
      }
    }

    res.json({
      success: true,
      phone: cleanPhone,
      message: `OTP generated for +91 ${cleanPhone}`,
      smsSent,
      smsProvider: fast2smsKey ? "fast2sms" : null,
      smsNote: smsError,
      directWhatsappLink: waLink,
      debug_otp: otp,
      expiresInSeconds: 300
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify OTP
app.post("/api/rewards/otp/verify", async (req, res) => {
  try {
    const rawPhone = String(req.body.phone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    const inputOtp = String(req.body.otp || '').trim();

    let isValid = (inputOtp === "123456"); // master demo fallback
    if (!isValid && cloudOtpStore.has(cleanPhone)) {
      const record = cloudOtpStore.get(cleanPhone);
      if (Date.now() <= record.expiresAt && record.otp === inputOtp) {
        isValid = true;
        cloudOtpStore.delete(cleanPhone);
      }
    }

    if (!isValid) {
      return res.status(400).json({ error: "Invalid or expired OTP code" });
    }

    let customerName = "Valued Customer";
    if (dbClient) {
      const db = dbClient.db("DMS");
      const cust = await db.collection("customer_stamps").findOne({ customerPhone: cleanPhone });
      if (cust?.customerName) customerName = cust.customerName;
      else {
        const inv = await db.collection("retail_invoices").findOne({ customerPhone: cleanPhone });
        if (inv?.customerName) customerName = inv.customerName;
      }
    }

    res.json({
      success: true,
      verified: true,
      customerPhone: cleanPhone,
      customerName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Qualified Invoices for Customer (Strict: only invoices that qualified for rewards)
app.get("/api/rewards/invoices/:phone", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const rawPhone = String(req.params.phone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: "Invalid 10-digit mobile number" });
    }

    const invoices = await db.collection("retail_invoices")
      .find({ customerPhone: cleanPhone, "stampData.isQualified": true })
      .sort({ createdAt: -1 })
      .toArray();

    const formatted = invoices.map(inv => ({
      invoiceId: inv._id.toString(),
      customerName: inv.customerName || "Customer",
      customerPhone: inv.customerPhone,
      date: inv.date,
      finalAmount: inv.finalAmount || 0,
      paidAmount: inv.paidAmount || 0,
      items: (inv.newItems || []).map(it => ({
        name: it.name || "Item",
        quantity: it.quantity || 1,
        rate: it.rate || 0,
        total: it.total || 0,
        rewardPercent: it.rewardPercent || 2,
        rewardValue: it.rewardValue || 0
      })),
      stampData: {
        isQualified: true,
        stampProcessed: inv.stampData?.stampProcessed ?? true,
        cycleId: inv.stampData?.cycleId?.toString() || "",
        cycleNumber: inv.stampData?.cycleNumber || 1,
        stampNumber: inv.stampData?.stampNumber || 1,
        invoiceRewardValue: inv.stampData?.invoiceRewardValue || 0,
        rawRewardValue: inv.stampData?.rawRewardValue || 0,
        accumulatedCycleReward: inv.stampData?.accumulatedCycleReward || 0,
        cycleCompleted: inv.stampData?.cycleCompleted || false,
        eligibleGift: inv.stampData?.eligibleGift || null,
        stampedAt: inv.stampData?.stampedAt || inv.date
      }
    }));

    res.json({
      success: true,
      customerPhone: cleanPhone,
      count: formatted.length,
      invoices: formatted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reward Handover (Ends completed cycle and starts next cycle for future visits)
app.post("/api/customer-stamps/handover-reward", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const cleanPhone = String(req.body.phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ error: "Invalid mobile number" });
    }
    const doc = await db.collection("customer_stamps").findOne({ customerPhone: cleanPhone });
    if (!doc || !doc.activeCycle || doc.activeCycle.status !== 'completed') {
      return res.status(400).json({ error: "No completed stamp cycle ready for reward handover" });
    }

    const completedRecord = {
      cycleId: doc.activeCycle.cycleId,
      cycleNumber: doc.activeCycle.cycleNumber,
      totalRewardValue: doc.activeCycle.accumulatedRewardValue,
      stampsCount: doc.activeCycle.currentStamps,
      giftGiven: doc.activeCycle.eligibleGift || "Completed 5-Stamp Reward",
      completedAt: doc.activeCycle.completedAt || new Date(),
      handedOverAt: new Date(),
      invoiceIds: (doc.activeCycle.invoices || []).map(i => i.invoiceId)
    };

    const nextCycleNumber = (doc.completedCycles?.length || 0) + 2;
    const newActiveCycle = {
      cycleId: new ObjectId().toString(),
      cycleNumber: nextCycleNumber,
      currentStamps: 0,
      targetStamps: 5,
      accumulatedRewardValue: 0,
      status: 'active',
      invoices: [],
      createdAt: new Date()
    };

    await db.collection("customer_stamps").updateOne(
      { customerPhone: cleanPhone },
      {
        $push: { completedCycles: completedRecord },
        $set: { activeCycle: newActiveCycle, updatedAt: new Date() }
      }
    );

    res.json({
      success: true,
      message: "Reward handed over successfully! Customer has started a fresh stamp cycle.",
      completedRecord,
      activeCycle: newActiveCycle
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// In-memory OTP storage for Cloud Server: phone -> { otp, expiresAt }
const cloudOtpStore = new Map();

// Send OTP via WhatsApp
app.post("/api/rewards/otp/send", async (req, res) => {
  try {
    const rawPhone = String(req.body.phone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: "Invalid 10-digit mobile number" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + (5 * 60 * 1000);
    cloudOtpStore.set(cleanPhone, { otp, expiresAt });

    const msg = `Namaste from Durga Metal Shop! Your loyalty verification code is: *${otp}*.\n\nValid for 5 minutes to access your 5-stamp rewards pass.`;
    const storeWa = process.env.WHATSAPP_PHONE_NUMBER || "9937009855";
    const waLink = `https://wa.me/91${storeWa}?text=${encodeURIComponent(msg)}`;

    let smsSent = false;
    let smsError = null;
    const fast2smsKey = process.env.FAST2SMS_API_KEY;
    if (fast2smsKey) {
      try {
        const fastResp = await fetch("https://www.fast2sms.com/dev/bulkV2", {
          method: "POST",
          headers: {
            "authorization": fast2smsKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            route: "otp",
            variables_values: otp,
            numbers: cleanPhone
          })
        });
        const fastData = await fastResp.json();
        if (fastData && fastData.return === true) {
          smsSent = true;
        } else {
          smsError = fastData.message || JSON.stringify(fastData);
        }
      } catch (err) {
        smsError = err.message;
      }
    }

    res.json({
      success: true,
      phone: cleanPhone,
      message: `OTP generated for +91 ${cleanPhone}`,
      smsSent,
      smsProvider: fast2smsKey ? "fast2sms" : null,
      smsNote: smsError,
      directWhatsappLink: waLink,
      debug_otp: otp,
      expiresInSeconds: 300
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify OTP
app.post("/api/rewards/otp/verify", async (req, res) => {
  try {
    const rawPhone = String(req.body.phone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    const inputOtp = String(req.body.otp || '').trim();

    let isValid = (inputOtp === "123456"); // master demo fallback
    if (!isValid && cloudOtpStore.has(cleanPhone)) {
      const record = cloudOtpStore.get(cleanPhone);
      if (Date.now() <= record.expiresAt && record.otp === inputOtp) {
        isValid = true;
        cloudOtpStore.delete(cleanPhone);
      }
    }

    if (!isValid) {
      return res.status(400).json({ error: "Invalid or expired OTP code" });
    }

    let customerName = "Valued Customer";
    if (dbClient) {
      const db = dbClient.db("DMS");
      const cust = await db.collection("customer_stamps").findOne({ customerPhone: cleanPhone });
      if (cust?.customerName) customerName = cust.customerName;
      else {
        const inv = await db.collection("retail_invoices").findOne({ customerPhone: cleanPhone });
        if (inv?.customerName) customerName = inv.customerName;
      }
    }

    res.json({
      success: true,
      verified: true,
      customerPhone: cleanPhone,
      customerName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Qualified Invoices for Customer (Strict: only invoices that qualified for rewards)
app.get("/api/rewards/invoices/:phone", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const rawPhone = String(req.params.phone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone;
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: "Invalid 10-digit mobile number" });
    }

    const invoices = await db.collection("retail_invoices")
      .find({ customerPhone: cleanPhone, "stampData.isQualified": true })
      .sort({ createdAt: -1 })
      .toArray();

    const formatted = invoices.map(inv => ({
      invoiceId: inv._id.toString(),
      customerName: inv.customerName || "Customer",
      customerPhone: inv.customerPhone,
      date: inv.date,
      finalAmount: inv.finalAmount || 0,
      paidAmount: inv.paidAmount || 0,
      items: (inv.newItems || []).map(it => ({
        name: it.name || "Item",
        quantity: it.quantity || 1,
        rate: it.rate || 0,
        total: it.total || 0,
        rewardPercent: it.rewardPercent || 2,
        rewardValue: it.rewardValue || 0
      })),
      stampData: {
        isQualified: true,
        stampProcessed: inv.stampData?.stampProcessed ?? true,
        cycleId: inv.stampData?.cycleId?.toString() || "",
        cycleNumber: inv.stampData?.cycleNumber || 1,
        stampNumber: inv.stampData?.stampNumber || 1,
        invoiceRewardValue: inv.stampData?.invoiceRewardValue || 0,
        rawRewardValue: inv.stampData?.rawRewardValue || 0,
        accumulatedCycleReward: inv.stampData?.accumulatedCycleReward || 0,
        cycleCompleted: inv.stampData?.cycleCompleted || false,
        eligibleGift: inv.stampData?.eligibleGift || null,
        stampedAt: inv.stampData?.stampedAt || inv.date
      }
    }));

    res.json({
      success: true,
      customerPhone: cleanPhone,
      count: formatted.length,
      invoices: formatted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats Summary
app.get("/api/stats-summary", async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  
  const { startDate, endDate, customerName, newItemName, scrapItemName, billType } = req.query;
  const collectionName = billType === 'retail' ? 'retail_invoices' : 'invoices';
  
  try {
    const db = dbClient.db("DMS");
    let matches = [];
    
    if (startDate || endDate) {
      let dateQuery = {};
      if (startDate) dateQuery.$gte = String(startDate);
      if (endDate) dateQuery.$lte = String(endDate);
      matches.push({ date: dateQuery });
    }
    
    if (customerName) {
      matches.push({ customerName: { $regex: String(customerName), $options: "i" } });
    }

    if (newItemName) matches.push({ "newItems.name": String(newItemName) });
    if (scrapItemName) matches.push({ "scrapItems.name": String(scrapItemName) });

    const finalMatch = matches.length > 0 ? { $and: matches } : {};

    const pipeline = [
      { $match: finalMatch },
      { 
        $group: {
          _id: null,
          totalSalesValue: { $sum: { $convert: { input: "$newTotal", to: "double", onError: 0 } } },
          totalScrapValue: { $sum: { $convert: { input: "$scrapTotal", to: "double", onError: 0 } } },
          totalFinalValue: { $sum: { $convert: { input: "$finalAmount", to: "double", onError: 0 } } },
          totalPaid: { $sum: { $convert: { input: "$paidAmount", to: "double", onError: 0 } } },
          totalDue: { $sum: { $convert: { input: "$remainingDue", to: "double", onError: 0 } } },
          invoiceCount: { $sum: 1 },
          customers: { $addToSet: "$customerName" }
        }
      }
    ];

    const qtyPipeline = [
      { $match: finalMatch },
      {
        $project: {
          newItems: {
            $filter: {
              input: "$newItems",
              as: "item",
              cond: newItemName ? { $eq: ["$$item.name", newItemName] } : true
            }
          },
          scrapItems: {
            $filter: {
              input: "$scrapItems",
              as: "item",
              cond: scrapItemName ? { $eq: ["$$item.name", scrapItemName] } : true
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSalesQuantity: { 
            $sum: { 
              $reduce: {
                input: "$newItems",
                initialValue: 0,
                in: { $add: ["$$value", { $convert: { input: "$$this.quantity", to: "double", onError: 0 } }] }
              }
            }
          },
          totalScrapQuantity: { 
            $sum: { 
              $reduce: {
                input: "$scrapItems",
                initialValue: 0,
                in: { $add: ["$$value", { $convert: { input: "$$this.quantity", to: "double", onError: 0 } }] }
              }
            }
          }
        }
      }
    ];

    const [mainAgg, qtyAgg] = await Promise.all([
      db.collection(collectionName).aggregate(pipeline).next(),
      db.collection(collectionName).aggregate(qtyPipeline).next()
    ]);

    const result = {
      totalSalesQuantity: qtyAgg?.totalSalesQuantity || 0,
      totalSalesValue: mainAgg?.totalSalesValue || 0,
      totalScrapQuantity: qtyAgg?.totalScrapQuantity || 0,
      totalScrapValue: mainAgg?.totalScrapValue || 0,
      totalFinalValue: mainAgg?.totalFinalValue || 0,
      totalPaid: mainAgg?.totalPaid || 0,
      totalDue: mainAgg?.totalDue || 0,
      customerCount: mainAgg?.customers?.length || 0,
      invoiceCount: mainAgg?.invoiceCount || 0
    };

    return res.json(result);
  } catch (error) {
    console.error(`❌ [Stats] Error:`, error);
    return res.status(500).json({ error: error.message });
  }
});

// DB Status Endpoint
app.get("/api/db-status", async (req, res) => {
  if (!dbClient) {
    await connectToMongo();
  }
  if (dbClient) {
    const db = dbClient.db("DMS");
    const adminCount = await db.collection("admin").countDocuments();
    if (adminCount === 0) {
      await db.collection("admin").insertOne({
        username: "admin",
        password: "password123",
        role: "admin",
        createdAt: new Date()
      });
      console.log("ℹ️ [DB] Created default admin account (admin/password123)");
    }
  }
  res.json({ connected: !!dbClient });
});

// Login Endpoint
app.post("/api/login", async (req, res) => {
  if (!dbClient) {
    await connectToMongo();
  }
  if (!dbClient) return res.status(503).json({ error: "Database offline. Please check your internet connection." });
  const { username, password } = req.body;
  try {
    const db = dbClient.db("DMS");
    const user = await db.collection("admin").findOne({ username, password });
    if (user) {
      res.json({ success: true, user: { username: user.username, role: user.role } });
    } else {
      res.status(401).json({ success: false, error: "Invalid credentials" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Estimates List
app.get("/api/estimates", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "Database offline" });
  const { name, date, billType } = req.query;
  const collectionName = billType === 'retail' ? 'retail_invoices' : 'invoices';
  try {
    const db = dbClient.db("DMS");
    let query = {};
    if (name) {
      query.$or = [
        { customerName: { $regex: name, $options: "i" } },
        { customerPhone: { $regex: name, $options: "i" } },
        { invoiceNo: { $regex: name, $options: "i" } }
      ];
    }
    if (date) query.date = date;

    const estimates = await db.collection(collectionName)
      .find(query)
      .sort({ date: -1, createdAt: -1 })
      .toArray();
    res.json(estimates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Merchants List
app.get("/api/merchants", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const merchantNames = await db.collection("merchant_payments").distinct("merchantName");
    const sorted = merchantNames.filter(n => typeof n === 'string' && n.trim() !== '').sort();
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Merchant Payment Save
app.post("/api/merchant-payments", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const { id, merchantName, date, amount, mode, purpose, invoiceAmount, oldBalance } = req.body;

    if (!merchantName || !date || typeof amount === 'undefined' || !mode) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const numAmount = Number(amount) || 0;
    const numInvoiceAmount = Number(invoiceAmount) || 0;
    const numOldBalance = Number(oldBalance) || 0;
    const remainingDue = Number(((numInvoiceAmount + numOldBalance) - numAmount).toFixed(2));

    const payload = {
      merchantName,
      date,
      invoiceAmount: numInvoiceAmount,
      oldBalance: numOldBalance,
      amount: numAmount,
      remainingDue,
      mode,
      purpose: purpose || '',
      updatedAt: new Date(),
    };

    if (id) {
      await db.collection("merchant_payments").updateOne(
        { _id: new ObjectId(id) },
        { $set: payload }
      );
      res.json({ success: true, id });
    } else {
      const insertPayload = {
        ...payload,
        createdAt: new Date(),
      };
      const result = await db.collection("merchant_payments").insertOne(insertPayload);
      res.json({ success: true, id: result.insertedId });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Merchant Payments List
app.get("/api/merchant-payments", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const { name, date, startDate, endDate } = req.query;
    let query = {};
    
    if (name) query.merchantName = { $regex: name, $options: "i" };
    if (date) query.date = date;
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = String(startDate);
      if (endDate) query.date.$lte = String(endDate);
    }

    const payments = await db.collection("merchant_payments")
      .find(query)
      .sort({ date: -1, createdAt: -1 })
      .toArray();
      
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Merchant Last Balance
app.get("/api/merchant-last-balance/:name", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const name = req.params.name.trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lastPayment = await db.collection("merchant_payments")
      .find({ merchantName: { $regex: new RegExp(`^${escaped}$`, 'i') } })
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .limit(1)
      .toArray();
    
    const balance = lastPayment.length > 0 ? (lastPayment[0].remainingDue || 0) : 0;
    let date = null;
    if (lastPayment.length > 0) {
      if (lastPayment[0].date) {
        date = lastPayment[0].date;
      } else if (lastPayment[0].createdAt) {
        try {
          date = new Date(lastPayment[0].createdAt).toISOString().split('T')[0];
        } catch {}
      }
    }
    res.json({ balance, date });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Customer Last Balance
app.get("/api/last-balance/:name", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  const collectionName = req.query.billType === 'retail' ? 'retail_invoices' : 'invoices';
  try {
    const db = dbClient.db("DMS");
    const name = req.params.name.trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lastInvoice = await db.collection(collectionName)
      .find({ customerName: { $regex: new RegExp(`^${escaped}$`, 'i') } })
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .limit(1)
      .toArray();
    
    const balance = lastInvoice.length > 0 ? (lastInvoice[0].remainingDue || 0) : 0;
    let date = null;
    if (lastInvoice.length > 0) {
      if (lastInvoice[0].date) {
        date = lastInvoice[0].date;
      } else if (lastInvoice[0].createdAt) {
        try {
          date = new Date(lastInvoice[0].createdAt).toISOString().split('T')[0];
        } catch {}
      }
    }
    res.json({ balance, date });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Next Sequential Bill Number for Retail (Fixed prefix DMS, Year YY, Month MM based on bill date)
app.get("/api/next-bill-number", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "DB Offline" });
  try {
    const db = dbClient.db("DMS");
    const { billType, date } = req.query;
    if (billType !== 'retail') {
      return res.json({ invoiceNo: null });
    }
    const dateParts = String(date || '').split('-');
    const yy = (dateParts[0] && dateParts[0].length >= 4) ? dateParts[0].slice(-2) : String(new Date().getFullYear()).slice(-2);
    const mm = (dateParts[1] && dateParts[1].length >= 1) ? dateParts[1].padStart(2, '0') : String(new Date().getMonth() + 1).padStart(2, '0');
    const period = `${yy}${mm}`;

    const counterDoc = await db.collection("counters").findOne({ _id: `retail_bill_${period}` });
    let currentSeq = counterDoc?.seq || 0;
    if (currentSeq === 0) {
      const pattern = new RegExp(`^DMS[/\\-]${period}[/\\-](\\d+)`);
      const lastInv = await db.collection("retail_invoices").find({ invoiceNo: { $regex: pattern } }).sort({ invoiceNo: -1 }).limit(1).toArray();
      if (lastInv.length > 0 && lastInv[0].invoiceNo) {
        const m = lastInv[0].invoiceNo.match(pattern);
        if (m && m[1]) currentSeq = parseInt(m[1], 10);
      }
    }
    const nextSeq = currentSeq + 1;
    const invoiceNo = `DMS/${period}/${String(nextSeq).padStart(4, '0')}`;
    res.json({ invoiceNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Estimate Endpoint
app.post("/api/save-estimate", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "Database offline" });
  try {
    const db = dbClient.db("DMS");
    const isRetail = req.body.billType === 'retail';
    const collectionName = isRetail ? 'retail_invoices' : 'invoices';
    const invoices = db.collection(collectionName);
    
    const { 
      id,
      invoiceNo: reqInvoiceNo,
      customerName, 
      customerPhone,
      date, 
      billType,
      newItems, 
      scrapItems, 
      newTotal, 
      scrapTotal,
      discount,
      finalAmount,
      oldBalance,
      totalOutstanding,
      cashAmount,
      onlineAmount,
      onlineMode,
      paidAmount,
      remainingDue
    } = req.body;

    if (!customerName || customerName.trim() === "") {
      return res.status(400).json({ error: "Customer name is required" });
    }
    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }

    const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
    if (isRetail) {
      if (!cleanPhone || cleanPhone.length < 10) {
        return res.status(400).json({ error: "Customer 10-digit mobile number is mandatory for Retail Estimates" });
      }
    }

    const validateItems = (items, type) => {
      if (!items || !Array.isArray(items)) return;
      items.forEach((item, index) => {
        if (!item.name || item.name.trim() === "") {
          throw new Error(`${type} item at row ${index + 1} must have a name`);
        }
        if (Number(item.quantity) <= 0) {
          throw new Error(`${type} item "${item.name}" must have a quantity greater than 0`);
        }
        if (Number(item.rate) < 0) {
          throw new Error(`${type} item "${item.name}" cannot have a negative rate`);
        }
      });
    };

    try {
      validateItems(newItems, "Sale");
      validateItems(scrapItems, "Scrap");
    } catch (valErr) {
      console.warn("⚠️ [Save] Validation failed:", valErr.message);
      return res.status(400).json({ error: valErr.message });
    }
    
    const sessionDate = new Date();
    const isUpdate = !!id;
    const targetId = isUpdate ? new ObjectId(id) : new ObjectId();

    // Reward and Stamp Engine for Retail Invoices
    let stampData = null;
    let processedNewItems = newItems;

    if (isRetail) {
      const stampSettings = await ensureStampSettings();
      const minInvoiceAmount = Number(stampSettings.minInvoiceAmount) || 200;
      const specialKeywords = stampSettings.specialKeywords || DEFAULT_STAMP_SETTINGS.specialKeywords;
      const specialRewardPercent = Number(stampSettings.specialRewardPercent) || 2;
      const standardRewardPercent = Number(stampSettings.standardRewardPercent) || 5;
      const roundingIncrement = Number(stampSettings.roundingIncrement) || 10;
      const targetStamps = Number(stampSettings.targetStamps) || 5;

      // 1. Calculate item-level rewards
      let rawRewardTotal = 0;
      processedNewItems = (newItems || []).map(item => {
        let percent = standardRewardPercent;
        if (item.rewardPercent !== undefined && item.rewardPercent !== null && item.rewardPercent !== '') {
          percent = Number(item.rewardPercent);
        } else if (isSpecialMetalItem(item.name, specialKeywords)) {
          percent = specialRewardPercent;
        }

        const itemTotal = Number(item.total) || (Number(item.quantity) * Number(item.rate)) || 0;
        const itemReward = Number(((itemTotal * percent) / 100).toFixed(2));
        rawRewardTotal += itemReward;

        return {
          ...item,
          gst: (item.gst !== undefined && item.gst !== null) ? Number(item.gst) : 0,
          rewardPercent: percent,
          rewardValue: itemReward
        };
      });

      rawRewardTotal = Number(rawRewardTotal.toFixed(2));

      // Rounding logic: floor to nearest 10 when >= 10, otherwise keep raw reward (e.g. ₹4 on ₹200 SS bill)
      const invoiceRewardValue = rawRewardTotal >= roundingIncrement 
        ? Math.floor(rawRewardTotal / roundingIncrement) * roundingIncrement 
        : Math.round(rawRewardTotal);

      const isQualified = Number(finalAmount) >= minInvoiceAmount;

      if (isQualified) {
        // Fetch or initialize customer stamp record
        const customerDoc = await db.collection("customer_stamps").findOne({ customerPhone: cleanPhone });
        let activeCycle = customerDoc?.activeCycle;

        // Check if updating an existing invoice that was already stamped
        let existingInvoice = null;
        if (isUpdate) {
          existingInvoice = await invoices.findOne({ _id: targetId });
        }

        if (existingInvoice && existingInvoice.stampData && existingInvoice.stampData.stampProcessed) {
          // Lock invoice to its existing cycle and stamp number (prevent double counting)
          const prevCycleId = existingInvoice.stampData.cycleId;
          const prevRewardVal = Number(existingInvoice.stampData.invoiceRewardValue) || 0;
          const rewardDiff = invoiceRewardValue - prevRewardVal;

          if (activeCycle && activeCycle.cycleId === prevCycleId && rewardDiff !== 0) {
            activeCycle.accumulatedRewardValue = Math.max(0, (activeCycle.accumulatedRewardValue || 0) + rewardDiff);
            // Update the invoice in activeCycle.invoices array
            activeCycle.invoices = (activeCycle.invoices || []).map(inv => {
              if (String(inv.invoiceId) === String(targetId)) {
                return { ...inv, invoiceAmount: Number(finalAmount), rewardValue: invoiceRewardValue };
              }
              return inv;
            });
            if (activeCycle.status === 'completed') {
              activeCycle.eligibleGift = matchGiftTier(activeCycle.accumulatedRewardValue, stampSettings.giftTiers);
            }
            await db.collection("customer_stamps").updateOne(
              { customerPhone: cleanPhone },
              { 
                $set: { activeCycle, updatedAt: new Date() },
                $inc: { totalLifetimeRewardValue: rewardDiff }
              }
            );
          }

          stampData = {
            ...existingInvoice.stampData,
            invoiceRewardValue,
            rawRewardValue: rawRewardTotal,
            accumulatedCycleReward: activeCycle?.accumulatedRewardValue || existingInvoice.stampData.accumulatedCycleReward,
            updatedAt: new Date()
          };
        } else {
          // Check 6-Hour Cooldown Period between stamps
          const cooldownHours = Number(stampSettings.cooldownHours ?? 6);
          let lastStampedAt = customerDoc?.lastStampedAt || null;
          if (!lastStampedAt && customerDoc?.activeCycle?.invoices?.length > 0) {
            const invs = customerDoc.activeCycle.invoices;
            lastStampedAt = invs[invs.length - 1].stampedAt;
          }

          let inCooldown = false;
          let hoursRemaining = 0;
          let minutesRemaining = 0;
          if (lastStampedAt) {
            const elapsedMs = sessionDate.getTime() - new Date(lastStampedAt).getTime();
            const elapsedHours = elapsedMs / (1000 * 60 * 60);
            if (elapsedHours < cooldownHours) {
              inCooldown = true;
              hoursRemaining = Number((cooldownHours - elapsedHours).toFixed(2));
              minutesRemaining = Math.max(1, Math.round((cooldownHours - elapsedHours) * 60));
            }
          }

          if (inCooldown) {
            // Customer is in cooldown! Invoice saves normally, but awards 0 stamps and no reward contribution.
            console.log(`⏳ [Cooldown] Customer ${cleanPhone} attempted stamp within ${cooldownHours}h cooldown (${minutesRemaining}m remaining). Stamping skipped.`);
            stampData = {
              isQualified: false,
              stampProcessed: false,
              inCooldown: true,
              cooldownHours,
              hoursRemaining,
              minutesRemaining,
              cycleId: activeCycle?.cycleId || null,
              invoiceRewardValue: 0,
              rawRewardValue: rawRewardTotal,
              message: `Customer is in ${cooldownHours}-hour cooldown period. Next stamp eligible in ${Math.floor(minutesRemaining / 60)}h ${minutesRemaining % 60}m.`,
              createdAt: sessionDate
            };
          } else {
            // New Stamp Assignment
            if (!activeCycle || activeCycle.status === 'completed' || activeCycle.status === 'reward_given') {
              const completedCount = customerDoc?.completedCycles?.length || 0;
              activeCycle = {
                cycleId: new ObjectId().toString(),
                cycleNumber: completedCount + 1,
                currentStamps: 0,
                targetStamps,
                accumulatedRewardValue: 0,
                status: 'active',
                invoices: [],
                createdAt: sessionDate
              };
            }

            const nextStampNumber = (activeCycle.currentStamps || 0) + 1;
            const newAccumulatedReward = (activeCycle.accumulatedRewardValue || 0) + invoiceRewardValue;
            const isCycleComplete = nextStampNumber >= targetStamps;

            activeCycle.currentStamps = nextStampNumber;
            activeCycle.accumulatedRewardValue = newAccumulatedReward;
            activeCycle.invoices = activeCycle.invoices || [];
            activeCycle.invoices.push({
              invoiceId: targetId,
              invoiceDate: date,
              invoiceAmount: Number(finalAmount) || 0,
              rewardValue: invoiceRewardValue,
              stampNumber: nextStampNumber,
              stampedAt: sessionDate
            });

            if (isCycleComplete) {
              activeCycle.status = 'completed';
              activeCycle.completedAt = sessionDate;
              activeCycle.eligibleGift = matchGiftTier(newAccumulatedReward, stampSettings.giftTiers);
            }

            await db.collection("customer_stamps").updateOne(
              { customerPhone: cleanPhone },
              {
                $set: {
                  customerName: customerName.trim(),
                  customerPhone: cleanPhone,
                  lastStampedAt: sessionDate,
                  activeCycle,
                  updatedAt: sessionDate
                },
                $inc: {
                  totalLifetimeStamps: 1,
                  totalLifetimeRewardValue: invoiceRewardValue
                },
                $setOnInsert: {
                  createdAt: sessionDate,
                  completedCycles: []
                }
              },
              { upsert: true }
            );

            stampData = {
              isQualified: true,
              stampProcessed: true,
              inCooldown: false,
              cycleId: activeCycle.cycleId,
              cycleNumber: activeCycle.cycleNumber,
              stampNumber: nextStampNumber,
              targetStamps,
              invoiceRewardValue,
              rawRewardValue: rawRewardTotal,
              accumulatedCycleReward: newAccumulatedReward,
              cycleCompleted: isCycleComplete,
              eligibleGift: activeCycle.eligibleGift || null,
              stampedAt: sessionDate
            };
          }
        }
      } else {
        // Did not qualify for stamps (invoice total < minInvoiceAmount)
        stampData = {
          isQualified: false,
          stampProcessed: false,
          cycleId: null,
          cycleNumber: null,
          stampNumber: 0,
          targetStamps,
          invoiceRewardValue: 0,
          rawRewardValue: rawRewardTotal,
          accumulatedCycleReward: 0,
          cycleCompleted: false,
          eligibleGift: null,
          reason: `Invoice total ₹${finalAmount} is below qualifying minimum of ₹${minInvoiceAmount}`
        };
      }
    }

    const masterPayload = {
      customerName: customerName.trim(),
      customerPhone: cleanPhone || '',
      date,
      billType: billType || 'wholesale',
      newItems: processedNewItems,
      scrapItems,
      newTotal,
      scrapTotal,
      discount: Number(discount) || 0,
      finalAmount,
      oldBalance,
      totalOutstanding,
      cashAmount: Number(cashAmount) || 0,
      onlineAmount: Number(onlineAmount) || 0,
      onlineMode: Number(onlineAmount) > 0 ? (onlineMode || '') : '',
      paidAmount,
      remainingDue,
      financial_summary: {
        bill_amount: finalAmount,
        discount: Number(discount) || 0,
        previous_balance: oldBalance,
        total_payable: totalOutstanding,
        cash_paid: Number(cashAmount) || 0,
        online_paid: Number(onlineAmount) || 0,
        online_mode: Number(onlineAmount) > 0 ? (onlineMode || '') : '',
        amount_paid: paidAmount,
        remaining_due: remainingDue
      },
      updatedAt: sessionDate,
    };

    let finalInvoiceNo = reqInvoiceNo;
    if (isRetail) {
      let existingInvoice = null;
      if (isUpdate) {
        existingInvoice = await invoices.findOne({ _id: targetId });
      }

      if (existingInvoice && existingInvoice.invoiceNo) {
        finalInvoiceNo = existingInvoice.invoiceNo;
      } else {
        // Sequential Bill Number: Fixed prefix DMS, Year YY, Month MM depending on bill date
        const dateParts = String(date || '').split('-');
        const yy = (dateParts[0] && dateParts[0].length >= 4) ? dateParts[0].slice(-2) : String(new Date().getFullYear()).slice(-2);
        const mm = (dateParts[1] && dateParts[1].length >= 1) ? dateParts[1].padStart(2, '0') : String(new Date().getMonth() + 1).padStart(2, '0');
        const period = `${yy}${mm}`;

        // Atomic counter increment
        const counterDoc = await db.collection("counters").findOneAndUpdate(
          { _id: `retail_bill_${period}` },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after' }
        );
        const nextSeq = counterDoc?.seq || counterDoc?.value?.seq || 1;
        finalInvoiceNo = `DMS/${period}/${String(nextSeq).padStart(4, '0')}`;
      }
      masterPayload.invoiceNo = finalInvoiceNo;
    }

    if (isRetail && stampData) {
      masterPayload.stampData = stampData;
    }

    if (isUpdate) {
      await invoices.updateOne(
        { _id: targetId },
        { $set: masterPayload }
      );
      res.json({ success: true, id: targetId, invoiceNo: finalInvoiceNo, stampData });
    } else {
      const result = await invoices.insertOne({
        ...masterPayload,
        _id: targetId,
        createdAt: sessionDate,
      });
      res.json({ success: true, id: result.insertedId, invoiceNo: finalInvoiceNo, stampData });
    }

    // Async background update of retail_items (for retail) or items (for wholesale)
    setImmediate(async () => {
      try {
        const targetCollection = isRetail ? "retail_items" : "items";
        const rateField = isRetail ? "rate" : "rate";
        const bulkOps = [];
        
        if (processedNewItems && Array.isArray(processedNewItems)) {
          processedNewItems.forEach((item) => {
            if (item.name && String(item.name).trim() !== '') {
              const updateDoc = {
                [rateField]: Number(item.rate) || 0,
                updatedAt: new Date()
              };
              if (isRetail) {
                if (item.rewardPercent !== undefined && item.rewardPercent !== null) {
                  updateDoc.rewardPercent = Number(item.rewardPercent);
                }
                if (item.gst !== undefined && item.gst !== null) {
                  updateDoc.gst = Number(item.gst);
                }
              }
              bulkOps.push({
                updateOne: {
                  filter: { name: item.name.trim(), type: 'new' },
                  update: { $set: updateDoc },
                  upsert: true
                }
              });
            }
          });
        }

        if (scrapItems && Array.isArray(scrapItems)) {
          scrapItems.forEach((item) => {
            if (item.name && String(item.name).trim() !== '') {
              bulkOps.push({
                updateOne: {
                  filter: { name: item.name.trim(), type: 'scrap' },
                  update: { $set: { [rateField]: Number(item.rate) || 0, updatedAt: new Date() } },
                  upsert: true
                }
              });
            }
          });
        }

        if (bulkOps.length > 0) {
          await db.collection(targetCollection).bulkWrite(bulkOps, { ordered: false });
          console.log(`✅ [DB] Bulk upserted ${bulkOps.length} items in ${targetCollection}`);
        }
      } catch (bgErr) {
        console.error("❌ [DB] Background items update failed:", bgErr);
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 [DMS Cloud Server] Listening on port ${PORT}`);
});
