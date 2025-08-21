require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const session = require('express-session');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const ExcelJS = require('exceljs');
const axios = require("axios");

const app = express();

// ------------------ Middleware ------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'campSecretKey',
    resave: false,
    saveUninitialized: true,
}));
app.use(express.json()); // For JSON
app.use(express.urlencoded({ extended: true })); // For FormData / URL-encoded forms

// ------------------ PostgreSQL Connection ------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("render") ? { rejectUnauthorized: false } : false
});

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
    const { email, amount, phone } = req.body; // include phone
  
    try {
      const response = await axios.post(
        "https://payproxyapi.hubtel.com/items/initiate",
        {
          totalAmount: amount,
          description: "Youth Camp 2025 Registration",
          callbackUrl: process.env.HUBTEL_CALLBACK_URL,
          returnUrl: "https://camp25-registration.onrender.com/payment-success.html",
          merchantAccountNumber: String(process.env.HUBTEL_MERCHANT_ACCOUNT).trim(), // ✅ use the merchant account
          clientReference: "CAMP-" + Date.now(),
          customerEmail: email,
          customerMsisdn: phone // ✅ forward phone to Hubtel
        },
        {
          headers: {
            Authorization: "Basic " + Buffer.from(
              process.env.HUBTEL_CLIENT_ID + ":" + process.env.HUBTEL_CLIENT_SECRET
            ).toString("base64"),
            "Content-Type": "application/json"
          }
        }
      );
  
      const { checkoutUrl, transactionId } = response.data.data;
  
      // Save transactionId to DB
      const client = await pool.connect();
      await client.query(
        `UPDATE campers SET transaction_id = $1 WHERE email = $2`,
        [transactionId, email]
      );
      client.release();
  
      res.json({ checkoutUrl });
    } catch (err) {
      console.error("Hubtel error:", err.response?.data || err.message);
      res.status(500).json({ message: "Hubtel payment init failed" });
    }
  });
// Hubtel Callback
app.post('/hubtel/callback', bodyParser.json(), async (req, res) => {
    try {
        const data = req.body;
        console.log("Hubtel Callback Data:", data);

        const transactionId = data.TransactionId;
        if (!transactionId) {
            console.error("No TransactionId in callback");
            return res.sendStatus(400);
        }

        // ✅ Call Hubtel Transaction Status API
        const verifyRes = await axios.get(
            `https://payproxyapi.hubtel.com/items/${transactionId}/status`,
            {
                headers: {
                    Authorization: "Basic " + Buffer.from(
                        process.env.HUBTEL_CLIENT_ID + ":" + process.env.HUBTEL_CLIENT_SECRET
                    ).toString("base64")
                }
            }
        );

        const statusData = verifyRes.data.data;
        const status = statusData.status;  // Success, Failed, Cancelled
        const amount = statusData.amount;
        const reference = statusData.clientReference;
        let email = statusData.customerEmail;
        let phone = statusData.customerMsisdn;

        const client = await pool.connect();

        // fallback to phone if no email
        if (!email && phone) {
            const result = await client.query(
                `SELECT email FROM campers WHERE phone = $1 LIMIT 1`,
                [phone]
            );
            if (result.rows.length > 0) {
                email = result.rows[0].email;
            }
        }

        if (!email) {
            console.error("No email/phone match found for transaction", transactionId);
            client.release();
            return res.sendStatus(400);
        }

        if (status === "Success") {
            await client.query(
                `UPDATE campers SET payment_status = $1 WHERE email = $2`,
                ['paid', email]
            );
            await sendReceiptEmail(email, reference, amount);
            client.release();
            return res.redirect("https://camp25-registration.onrender.com/payment-success.html");
        } else {
            await client.query(
                `UPDATE campers SET payment_status = $1 WHERE email = $2`,
                ['failed', email]
            );
            client.release();
            return res.redirect("https://camp25-registration.onrender.com/payment-failed.html");
        }

    } catch (err) {
        console.error("Hubtel Callback Error:", err.response?.data || err.message);
        res.sendStatus(500);
    }
});

// Check Hubtel Transaction Status + Auto Update DB
app.get("/hubtel/check-status/:transactionId", async (req, res) => {
    const { transactionId } = req.params;
  
    try {
      const { data: raw } = await axios.get(
        `https://payproxyapi.hubtel.com/items/${transactionId}/status`,
        {
          headers: {
            Authorization: "Basic " + Buffer.from(
              process.env.HUBTEL_CLIENT_ID + ":" + process.env.HUBTEL_CLIENT_SECRET
            ).toString("base64"),
            "Content-Type": "application/json"
          }
        }
      );
  
      const d = raw?.data || {};
      const status = d.status; // Success / Failed / Pending / Cancelled
      const amount = d.amount;
      const reference = d.clientReference;
  
      let email = d.customerEmail || d.customer?.email || null;
      const msisdn = d.customerMsisdn || d.customer?.msisdn || null;
  
      const client = await pool.connect();
  
      // Try to resolve email by phone if missing
      if (!email && msisdn) {
        const q = await client.query(`SELECT email FROM campers WHERE phone = $1 LIMIT 1`, [msisdn]);
        if (q.rows.length) email = q.rows[0].email;
      }
  
      if (email) {
        // Check current status to avoid duplicate receipts
        const cur = await client.query(`SELECT payment_status, amount FROM campers WHERE email = $1 LIMIT 1`, [email]);
        const currentStatus = cur.rows[0]?.payment_status;
  
        if (status === "Success") {
          if (currentStatus !== 'paid') {
            await client.query(`UPDATE campers SET payment_status = 'paid' WHERE email = $1`, [email]);
            await sendReceiptEmail(email, reference, amount);
          }
        } else if (status === "Failed") {
          await client.query(`UPDATE campers SET payment_status = 'failed' WHERE email = $1`, [email]);
        }
      }
  
      client.release();
      res.json(raw);
    } catch (err) {
      console.error("Hubtel status check error:", err.response?.data || err.message);
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
      // Extract body whether it's JSON or FormData (urlencoded)
      let email = req.body.email;
      let reference = req.body.reference;
  
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

// ------------------ Start Server ------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
