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
                <p>Your registration is confirmed. Just one more step — kindly make payment to complete your registration!</p>
                <p>Your selected pass: <b>${passLabel}</b> | Amount: GHS ${amount}</p>
                <p>We are excited to meet you!</p>
                <p>God bless you,<br><b>REPLIB Youth Team</b></p>
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
    const { email, amount } = req.body;

    try {
        const response = await axios.post(
            "https://payproxyapi.hubtel.com/items/initiate",
            {
                totalAmount: amount,
                description: "Youth Camp 2025 Registration",
                callbackUrl: process.env.HUBTEL_CALLBACK_URL,
                returnUrl: "https://camp25-registration.onrender.com/payment-success.html",
                merchantAccountNumber: process.env.HUBTEL_CLIENT_ID,
                clientReference: "CAMP-" + Date.now(),
                customerEmail: email
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
app.post("/admin/confirm-payment", checkAdminAuth, bodyParser.urlencoded({ extended: true }), async (req, res) => {
    const { email, reference } = req.body;

    try {
        const client = await pool.connect();
        const result = await client.query(
            `UPDATE campers 
             SET payment_status = $1 
             WHERE email = $2 
             RETURNING email, amount`,
            ['paid', email]
        );
        client.release();

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Camper not found" });
        }

        // Camper details
        const camper = result.rows[0];

        // Send receipt email
        await sendReceiptEmail(email, reference || "Manual-Confirmation", camper.amount);

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
