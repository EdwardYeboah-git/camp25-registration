require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session)
const PDFDocument = require('pdfkit');
const fs = require('fs');
const ExcelJS = require('exceljs');
const axios = require("axios");

const app = express();

// ------------------ Middleware ------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render") ? { rejectUnauthorized: false } : false
});

app.use(session({
store: new pgSession({ pool, tableName: 'session' }),
secret: process.env.SESSION_SECRET || 'campSecretKey',
resave: false,
saveUninitialized: false,
cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
}
}));
app.use(express.json()); // For JSON
app.use(express.urlencoded({ extended: true })); // For FormData / URL-encoded forms


// ------------------ Nodemailer Transporter ------------------
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// ------------------ Routes ------------------

// Registration Route
app.post('/register', async (req, res) => {
    try {
        const { fullname, email, phone, passType, age, gender, church } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        // Determine amount (fix applied)
        let amount = 999;
        let passLabel = "General Pass";

        if (passType === 'team') {
        amount = 4500;
        passLabel = "Team Pass";
        }

        const client = await pool.connect();
        await client.query(
            `INSERT INTO campers(fullname, email, phone, pass_type, amount, payment_status, age, gender, church)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [fullname, email, phone, passLabel, amount, 'pending', age, gender, church]
        );
        client.release();

        // Send confirmation email
        await transporter.sendMail({
            from: `"REPLIB Youth Camp" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Youth Camp Registration Successful',
            html: `
                <h2>Hello ${fullname},</h2>
                <h3>Thank you for registering for REPLIB Youth Camp 2025.</h3>
                <p>Your registration was successful and has been confirmed.</p>
                <p>Your selected pass: <b>${passLabel}</b> | Amount: GHS ${amount}</p>
                <p>You will receive an E- receipt after completing payment of your registration. </p>
                <p>Kindly present this receipt at our frontdesk upon arrival..</p>
                <p>We are excited to have you join us for this unforgetable experience!</p>
                <p>God richly bless you,${fullname}<br><b>REPLIB Youth Team</b></p>
                <img src="https://camp25-registration.onrender.com//images/church-logo.png" alt="Signature" style="max-width:100px;">
            `
        });

        res.json({ message: "Registration successful! Please proceed to payment." });

    } catch (err) {
        console.error("Registration error:", err);
        res.status(500).json({ message: "Error registering camper" });
    }
});

// ------------------ Hubtel Payment ------------------

// Create Hubtel Payment
app.post("/hubtel/create-payment", async (req, res) => {
  try {
    let { email, amount, phone } = req.body;

    if (!email || !amount) {
      return res.status(400).json({ message: "Email and amount are required" });
    }

    // Normalize phone
    const normalizePhone = (phone) => {
      if (!phone) return null;
      let p = phone.trim().replace(/[\s-]/g, "");
      if (p.startsWith("+")) p = p.slice(1);
      if (p.startsWith("0") && p.length === 10) p = "233" + p.slice(1);
      return p;
    };
    const msisdn = normalizePhone(phone);
    console.log("Initiating Payment request")


    // Build Authorization  
    const auth = "Basic RXh6a0x2azplOTlhYTE5YTYyNjg0NzhkYjQ2N2YwYmMzNzI4YTNkMQ==";
    
    const clientReference = "CAMP-" + Date.now();

    const payload = {
      totalAmount: 0.1,
      description: "Youth Camp 2025 Registration",
      callbackUrl: "https://camp25-registration.onrender.com/hubtel/callback",
      returnUrl: "https://camp25-registration.onrender.com/payment-success.html",
      merchantAccountNumber: "2031237",
      cancellationUrl: "https://camp25-registration.onrender.com/payment-cancelled.html",
      clientReference,
      customerEmail: email,
      ...(msisdn ? { customerMsisdn: msisdn } : {})
    };

    const response = await axios.post(
      "https://payproxyapi.hubtel.com/items/initiate",
      payload,
      {
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 20000
      }
    );
      console.log("Response: " + response)
    const { checkoutUrl } = response.data.data;

    // Save clientReference to DB
    const client = await pool.connect();
    await client.query(
      `UPDATE campers SET transaction_id = $1 WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))`,
      [clientReference, email.trim().toLowerCase()]
    );
    client.release();

    res.json({ checkoutUrl, clientReference });
  } catch (err) {
    console.error("Hubtel init error:", err.response?.status, err.response?.data || err.message);
    res.status(500).json({
      message: "Hubtel payment init failed",
      hubtelStatus: err.response?.status || null,
      hubtelError: err.response?.data || err.message
    });
  }
});

// Hubtel Callback
app.post('/hubtel/callback', bodyParser.json(), async (req, res) => {
  try {
    console.log("🔔 Hubtel Callback HIT!");   // ✅ Confirm Hubtel reached your server
    console.log("📦 Raw Callback Headers:", req.headers);
    console.log("📨 Raw Callback Body:", req.body);

    const data = req.body;
    
    const clientReference = data.ClientReference;
    if (!clientReference) {
      console.error("❌ No ClientReference in callback");
      return res.sendStatus(400);
    }

    const auth = "Basic RXh6a0x2azplOTlhYTE5YTYyNjg0NzhkYjQ2N2YwYmMzNzI4YTNkMQ==" 

    // Verify transaction status with Hubtel
    const verifyRes = await axios.get(
      `https://api-txnstatus.hubtel.com/transactions/2031237/status?clientReference=${clientReference}`,
      {
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 20000
      }
    );

    const statusData = verifyRes.data.data;
    console.log("✅ Hubtel Verified Status:", statusData);

    const status = statusData.status; // Success, Failed, Cancelled, Pending
    const amount = statusData.amount;
    const reference = statusData.clientReference;
    let email = statusData.customerEmail;
    let phone = statusData.customerMsisdn;

    // Normalize phone number for consistency
    const normalizePhone = (phone) => {
      if (!phone) return null;
      let p = phone.trim().replace(/[\s-]/g, "");
      if (p.startsWith("+")) p = p.slice(1);
      if (p.startsWith("0") && p.length === 10) p = "233" + p.slice(1);
      return p;
    };
    const msisdn = normalizePhone(phone);

    const client = await pool.connect();

    // 🔄 If no email, try to fetch by phone
    if (!email && msisdn) {
      const result = await client.query(
        `SELECT email FROM campers WHERE phone = $1 LIMIT 1`,
        [msisdn]
      );
      if (result.rows.length > 0) {
        email = result.rows[0].email;
      }
    }

    if (!email) {
      console.error("❌ No email/phone match found for transaction", clientReference);
      client.release();
      return res.sendStatus(400);
    }

    if (status === "Success") {
      await client.query(
        `UPDATE campers SET payment_status = $1 WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))`,
        ['paid', email.trim().toLowerCase()]
      );
      await sendReceiptEmail(email, reference, amount);

      client.release();
      return res.redirect("https://camp25-registration.onrender.com/payment-success.html");
    } else {
      await client.query(
        `UPDATE campers SET payment_status = $1 WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))`,
        ['failed', email.trim().toLowerCase()]
      );

      client.release();
      return res.redirect("https://camp25-registration.onrender.com/payment-failed.html");
    }

  } catch (err) {
    console.error("❌ Hubtel Callback Error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});
 
  

// Check Hubtel Transaction Status + Auto Update DB
app.get("/hubtel/check-status/:clientReference", async (req, res) => {
  try {
    const { clientReference } = req.params;

    const auth = "Basic RXh6a0x2azplOTlhYTE5YTYyNjg0NzhkYjQ2N2YwYmMzNzI4YTNkMQ==" 

    // 🔍 Call Hubtel API
    const { data: raw } = await axios.get(
      `https://api-txnstatus.hubtel.com/transactions/2031237/status?clientReference=${clientReference}`,
      {
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 20000
      }
    );

    const d = raw?.data || {};
    console.log("🔎 Hubtel Status Check Response:", d);

    const status = d.status; // Success / Failed / Pending / Cancelled
    const amount = d.amount;
    const reference = d.clientReference;

    let email = d.customerEmail || d.customer?.email || null;
    let phone = d.customerMsisdn || d.customer?.msisdn || null;

    // ✅ Normalize phone number
    const normalizePhone = (phone) => {
      if (!phone) return null;
      let p = phone.trim().replace(/[\s-]/g, "");
      if (p.startsWith("+")) p = p.slice(1);
      if (p.startsWith("0") && p.length === 10) p = "233" + p.slice(1);
      return p;
    };
    const msisdn = normalizePhone(phone);

    const client = await pool.connect();

    // 🔄 If no email, try resolving by phone
    if (!email && msisdn) {
      const q = await client.query(
        `SELECT email FROM campers WHERE phone = $1 LIMIT 1`,
        [msisdn]
      );
      if (q.rows.length) email = q.rows[0].email;
    }

    if (email) {
      const normalizedEmail = email.trim().toLowerCase();

      const cur = await client.query(
        `SELECT payment_status, amount FROM campers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`,
        [normalizedEmail]
      );

      const currentStatus = cur.rows[0]?.payment_status;

      if (status === "Success") {
        if (currentStatus !== "paid") {
          await client.query(
            `UPDATE campers SET payment_status = 'paid' WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
            [normalizedEmail]
          );
          await sendReceiptEmail(normalizedEmail, reference, amount);
        }
      } else if (status === "Failed") {
        await client.query(
          `UPDATE campers SET payment_status = 'failed' WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
          [normalizedEmail]
        );
      }
    } else {
      console.warn("⚠ No email or phone match for transaction:", clientReference);
    }

    client.release();
    res.json(raw);

  } catch (err) {
    console.error("❌ Hubtel status check error:", err.response?.data || err.message);
    res.status(500).json({ message: "Error checking transaction status" });
  }
});

// ------------------ Admin Routes ------------------
// Admin login
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        req.session.admin = true;
        return res.json({ message: "Login successful" });
    }
    res.status(401).json({ message: "Invalid credentials" });
});

// Middleware for admin authentication
function checkAdminAuth(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }
    return res.status(403).json({ message: "Unauthorized" });
}

// Fetch campers
app.get('/admin/campers', checkAdminAuth, async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT fullname, email, phone, pass_type, amount, payment_status, age, gender, church FROM campers`
        );
        client.release();
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error fetching campers" });
    }
});

// Download campers as Excel
app.get('/admin/download-excel', checkAdminAuth, async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT fullname, email, phone, pass_type, amount, payment_status, age, gender, church FROM campers`
        );
        client.release();

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Campers');

        sheet.columns = [
            { header: 'Full Name', key: 'fullname' },
            { header: 'Email', key: 'email' },
            { header: 'Phone', key: 'phone' },
            { header: 'Pass Type', key: 'pass_type' },
            { header: 'Amount', key: 'amount' },
            { header: 'Payment Status', key: 'payment_status' },
            { header: 'Age', key: 'age' },
            { header: 'Gender', key: 'gender' },
            { header: 'Church / Assembly', key: 'church' }
        ];

        sheet.addRows(result.rows);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=campers.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error generating Excel" });
    }
});

// Confirm payment manually (bank transfer)
app.post("/admin/confirm-payment", checkAdminAuth, async (req, res) => {
    try {
      let { email, reference } = req.body;
  
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
  
      if (!reference || reference.trim() === "") {
        reference = "Manual-Confirmation";
      }
  
      const client = await pool.connect();
      const result = await client.query(
        `UPDATE campers 
         SET payment_status = $1 
         WHERE LOWER(TRIM(email)) = LOWER(TRIM($2)) 
         RETURNING email, amount`,
        ["paid", email.trim().toLowerCase()]
      );
      client.release();
  
      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Camper not found" });
      }
  
      const camper = result.rows[0];
  
      // Send receipt email
      await sendReceiptEmail(camper.email, reference, camper.amount);

    res.json({ message: "Payment confirmed" });
  } catch (err) {
    console.error("Manual confirmation error:", err);
    res.status(500).json({ message: "Error confirming payment" });
  }
});

// ------------------ Helper Functions ------------------
async function sendReceiptEmail(email, reference, amount) {
    const doc = new PDFDocument();
    const receiptPath = path.join(__dirname, `receipt-${Date.now()}.pdf`);

    doc.pipe(fs.createWriteStream(receiptPath));
    doc.fontSize(20).text('Official Payment Receipt', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Email: ${email}`);
    doc.text(`Amount: GHS ${amount}`);
    doc.text(`Reference: ${reference}`);
    doc.end();

    await new Promise(resolve => doc.on('finish', resolve));

    await transporter.sendMail({
        from: `"REPLIB Youth Camp" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Youth Camp Payment Receipt',
        text: 'Thank you for your payment. Please find your receipt attached.',
        attachments: [{ filename: 'receipt.pdf', path: receiptPath }],
    });

    fs.unlinkSync(receiptPath);
}

// ------------------ Test Endpoint ------------------
app.post("/ping", (req, res) => {
  console.log("✅ /ping POST request received:", req.body);
  res.json({ message: "Ping received!", data: req.body });
});


// ------------------ Start Server ------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
