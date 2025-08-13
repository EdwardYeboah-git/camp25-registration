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
const cors = require('cors');

const app = express();


app.use(cors({
    origin: 'https://edwardyeboah-git.github.io.', // your GitHub Pages site
    methods: ['GET', 'POST'],
    credentials: true
}));

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
        let amount = passType.toLowerCase() === 'team' ? 4500 : 999;

        const client = await pool.connect();
        await client.query(
            `INSERT INTO registrations(fullname, email, phone, pass_type, amount, payment_status, age, gender, church)
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
                <h3>Thank you for registering for REPLIB Youth Camp 2025, ${fullname}.</h3>
                <p><h3>Congratulations!<h3>Your registration is successful and has been confirmed.<p> 
                <p>You will receive an E- receipt after completing payment of your registration.</p>
                <p>Your selected pass: <b>${passType}</b> | Amount: GHS ${amount}</p>
                <p>Kindly present this receipt at our frontdesk upon arrival.<p>
                <p>We are excited to have you join us for this unforgettable experience.<p>
                <p>Can't wait to meet you, ${fullname}!</p>
                <br>
                <p>God bless you,<br><b>REPLIB Youth Team</b></p>
                <img src="https://camp25-registration.onrender.com//images/church-logo.png" alt="Signature" style="max-width:200px;">
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
        const { customer, reference, amount, metadata } = event.data;

        try {
            const passType = metadata?.passType || "General";
            const dbAmount = passType.toLowerCase() === 'team' ? 4500 : 999;

            const client = await pool.connect();
            await client.query(
                `UPDATE campers 
                 SET payment_status = $1, pass_type = $2, amount = $3
                 WHERE email = $4`,
                ['paid', passType, dbAmount, customer.email]
            );
            client.release();

            await sendReceiptEmail(customer.email, reference, dbAmount, passType);
        } catch (err) {
            console.error("Webhook error:", err);
        }
    }

    res.sendStatus(200);
});

// Manual Admin Payment Confirmation
app.post('/admin/confirm-payment', async (req, res) => {
    const { email, reference, passType } = req.body;

    try {
        const amount = passType && passType.toLowerCase() === 'team' ? 4500 : 999;

        const client = await pool.connect();
        await client.query(
            `UPDATE campers SET payment_status = $1, pass_type = $2, amount = $3 WHERE email = $4`,
            ['paid', passType || 'General', amount, email]
        );
        client.release();

        await sendReceiptEmail(email, reference || 'BANK-' + Date.now(), amount, passType || 'General');
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
async function sendReceiptEmail(email, reference, amount, passType) {
    const doc = new PDFDocument();
    const receiptPath = path.join(__dirname, `receipt-${Date.now()}.pdf`);

    doc.pipe(fs.createWriteStream(receiptPath));
    doc.fontSize(20).text('Official Payment Receipt', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Email: ${email}`);
    doc.text(`Pass Type: ${passType}`);
    doc.text(`Amount: GHS ${amount}`);
    doc.text(`Reference: ${reference}`);
    doc.end();

    await new Promise(resolve => doc.on('finish', resolve));

    await transporter.sendMail({
        from: `"Replicants Youth" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Youth Camp Payment Receipt',
        html: `
            <h3>Dear Camper,</h3>
            <p>We have received your payment for the REPLIB Youth Camp 2025.</p>
            <p>Find attached your official payment receipt.</p>
            <br>
            <p>God bless you,<br><b>REPLIB Youth Team</b></p>
            <img src="https://i.ibb.co/4s5Thtf/signature.png" alt="Signature" style="max-width:200px;">
        `,
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
