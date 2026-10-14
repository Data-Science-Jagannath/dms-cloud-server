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
    await db.collection("retail_invoices").createIndex({ date: -1 });
    await db.collection("retail_invoices").createIndex({ "newItems.name": 1 });
    await db.collection("retail_invoices").createIndex({ "scrapItems.name": 1 });
    
    // Items collection index for fast rate lookups
    await db.collection("items").createIndex({ name: 1, type: 1 }, { unique: true });
    
    console.log("🚀 [DB] Performance indexes verified");
  } catch (err) {
    console.error("❌ [DB] Index error:", err);
  }
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
    if (name) query.customerName = { $regex: name, $options: "i" };
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

// Save Estimate Endpoint
app.post("/api/save-estimate", async (req, res) => {
  if (!dbClient) return res.status(503).json({ error: "Database offline" });
  try {
    const db = dbClient.db("DMS");
    const collectionName = req.body.billType === 'retail' ? 'retail_invoices' : 'invoices';
    const invoices = db.collection(collectionName);
    
    const { 
      id,
      customerName, 
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

    const masterPayload = {
      customerName,
      date,
      billType: billType || 'wholesale',
      newItems,
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

    if (isUpdate) {
      await invoices.updateOne(
        { _id: targetId },
        { $set: masterPayload }
      );
      res.json({ success: true, id: targetId });
    } else {
      const result = await invoices.insertOne({
        ...masterPayload,
        _id: targetId,
        createdAt: sessionDate,
      });
      res.json({ success: true, id: result.insertedId });
    }

    // Async background update of items collection with latest rates
    const rateField = (billType === 'retail') ? 'retail_rate' : 'rate';
    setImmediate(async () => {
      try {
        const bulkOps = [];
        
        if (newItems && Array.isArray(newItems)) {
          newItems.forEach((item) => {
            if (item.name && String(item.name).trim() !== '') {
              bulkOps.push({
                updateOne: {
                  filter: { name: item.name, type: 'new' },
                  update: { $set: { [rateField]: Number(item.rate) || 0, updatedAt: new Date() } },
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
                  filter: { name: item.name, type: 'scrap' },
                  update: { $set: { [rateField]: Number(item.rate) || 0, updatedAt: new Date() } },
                  upsert: true
                }
              });
            }
          });
        }

        if (bulkOps.length > 0) {
          await db.collection("items").bulkWrite(bulkOps, { ordered: false });
          console.log(`✅ [DB] Bulk upserted ${bulkOps.length} ${rateField} rates`);
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
