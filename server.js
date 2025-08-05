require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const session = require('express-session');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'campSecretKey',
    resave: false,
    saveUninitialized: true,
}));

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("render") ? { rejectUnauthorized: false } : false
});

// Nodemailer transporter
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

        // Normalize amount based on pass type
        let amount = 999;
        if (passType === 'Team Pass') {
            amount = 4500;
        }

        const client = await pool.connect();
        await client.query(
            `INSERT INTO campers(fullname, email, phone, pass_type, amount, payment_status, age, gender, church)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [fullname, email, phone, passType, amount, 'pending', age, gender, church]
        );
        client.release();

        // Send confirmation email
        await transporter.sendMail({
            from: `"REPLIB YOUTH CAMP" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Youth Camp Registration Successful',
            html: `
                <h2>Hello ${fullname},</h2>

                <h3>Thank you for registering for REPLIB Youth Camp 2025.</h3>

                <p>Your registration for REPLIB Youth Camp 2025 is confirmed. Just one more step to complete your registration!</p>

                <p>Your selected pass: <b>${passType}</b> | Amount: GHS ${amount}</p>
                
                <p>We are absolutely excited to meet you.</p>
                
                <p>God bless you,<br>REPLIB Youth Team</p>
            `
        });

        res.json({ message: "Registration successful! Please proceed to payment." });

    } catch (err) {
        console.error("Registration error:", err);
        res.status(500).json({ message: "Error registering camper" });
    }
});

// Paystack Webhook
app.post('/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto.createHmac('sha512', secret)
        .update(req.body)
        .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        return res.status(403).send('Invalid signature');
    }

    const event = JSON.parse(req.body.toString());
    if (event.event === 'charge.success') {
        const { customer, reference, amount } = event.data;

        try {
            const client = await pool.connect();
            await client.query(
                `UPDATE campers SET payment_status = $1 WHERE email = $2`,
                ['paid', customer.email]
            );
            client.release();

            await sendReceiptEmail(customer.email, reference, amount / 100);
        } catch (err) {
            console.error("Webhook error:", err);
        }
    }

    res.sendStatus(200);
});

// Manual Admin Payment Confirmation
app.post('/admin/confirm-payment', async (req, res) => {
    const { email, reference } = req.body;

    try {
        const client = await pool.connect();
        const camperResult = await client.query(
            `SELECT amount FROM campers WHERE email = $1`,
            [email]
        );

        if (camperResult.rows.length === 0) {
            client.release();
            return res.status(404).json({ message: "Camper not found" });
        }

        const amount = camperResult.rows[0].amount;
        await client.query(
            `UPDATE campers SET payment_status = $1 WHERE email = $2`,
            ['paid', email]
        );
        client.release();

        await sendReceiptEmail(email, reference || 'BANK-' + Date.now(), amount);
        res.json({ message: `Payment confirmed and receipt sent to ${email}` });
    } catch (err) {
        console.error("Manual payment error:", err);
        res.status(500).json({ message: "Error confirming payment" });
    }
});

// Admin login
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        req.session.admin = true;
        return res.json({ message: "Login successful" });
    }
    res.status(401).json({ message: "Invalid credentials" });
});

// Admin Auth Middleware
function checkAdminAuth(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }
    return res.status(403).json({ message: "Unauthorized" });
}

// Fetch Campers
app.get('/admin/campers', checkAdminAuth, async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT fullname, email, phone, pass_type, amount, payment_status FROM campers`
        );
        client.release();
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error fetching campers" });
    }
});

// Download Excel
app.get('/admin/download-excel', checkAdminAuth, async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT fullname, email, phone, pass_type, amount, payment_status FROM campers`
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

// ------------------ Helper Function ------------------
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
        from: `"Replicants Youth" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Youth Camp Payment Receipt',
        text: 'Thank you for your payment. Please find your receipt attached.',
        attachments: [
            {
                filename: 'receipt.pdf',
                path: receiptPath,
            },
        ],
    });

    fs.unlinkSync(receiptPath);
}

// ------------------ Start Server ------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
