const express = require("express");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// --- Database ---
const db = new sqlite3.Database("./hotspot.db");
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        phone TEXT,
        plan TEXT,
        amount INTEGER,
        status TEXT,
        provider_ref TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS vouchers (
        id TEXT PRIMARY KEY,
        phone TEXT,
        plan TEXT,
        amount INTEGER,
        voucher TEXT,
        status TEXT,
        expires_at DATETIME
    )`);
});

// --- Helper: calculate expiry ---
function getExpiry(plan) {
    const now = new Date();
    switch (plan) {
        case "1000": now.setHours(now.getHours() + 6); break;
        case "2000": now.setHours(now.getHours() + 12); break;
        case "5000": now.setDate(now.getDate() + 7); break;
        case "30000": now.setDate(now.getDate() + 30); break;
        default: now.setHours(now.getHours() + 6);
    }
    return now.toISOString();
}

// --- MTN Sandbox Config ---
const MTN_API_BASE = "https://sandbox.momodeveloper.mtn.com/collection/v1_0";
const MTN_USER_ID = "YOUR_USER_ID";
const MTN_API_KEY = "YOUR_API_KEY";
const MTN_SHORTCODE = "YOUR_SHORTCODE";
const MTN_PRIMARY_KEY = "YOUR_PRIMARY_KEY"; // if needed for auth

// Get OAuth token from MTN Sandbox
async function getMTNToken() {
    const res = await axios.post("https://sandbox.momodeveloper.mtn.com/collection/token/", null, {
        headers: {
            "Ocp-Apim-Subscription-Key": MTN_API_KEY
        },
        auth: {
            username: MTN_USER_ID,
            password: MTN_PRIMARY_KEY
        }
    });
    return res.data.access_token;
}

// --- Endpoint: initiate MTN payment ---
app.post("/api/pay", async (req, res) => {
    try {
        const { phone, plan, amount } = req.body;
        const paymentId = uuidv4();

        // Store pending payment
        db.run(`INSERT INTO payments (id, phone, plan, amount, status) VALUES (?, ?, ?, ?, ?)`,
            [paymentId, phone, plan, amount, "pending"]);

        // 1) Request MTN payment
        const token = await getMTNToken();
        const externalId = paymentId;
        const callbackUrl = "https://your-server.com/mtn/webhook"; // public endpoint for MTN sandbox

        // Sandbox API call
        const response = await axios.post(`${MTN_API_BASE}/requesttopay`, {
            amount: amount.toString(),
            currency: "UGX",
            externalId,
            payer: { partyIdType: "MSISDN", partyId: phone },
            payerMessage: "Hotspot Payment",
            payeeNote: "Hotspot subscription"
        }, {
            headers: {
                Authorization: `Bearer ${token}`,
                "X-Reference-Id": externalId,
                "X-Target-Environment": "sandbox",
                "Ocp-Apim-Subscription-Key": MTN_API_KEY,
                "Content-Type": "application/json"
            }
        });

        res.json({ ok: true, paymentId });
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.json({ ok: false, error: err.message });
    }
});

// --- Endpoint: Voucher Polling ---
app.get("/api/voucher/:paymentId", (req, res) => {
    const paymentId = req.params.paymentId;
    db.get(`SELECT v.voucher, v.expires_at
            FROM vouchers v
            JOIN payments p ON p.phone = v.phone
            WHERE p.id = ? AND v.status = 'active'
            ORDER BY v.expires_at DESC LIMIT 1`, [paymentId], (err, row) => {
        if (err || !row) return res.json({ ok: false });
        res.json({ ok: true, voucher: row.voucher, expires_at: row.expires_at });
    });
});

// --- Endpoint: Check expiry ---
app.get("/api/check-expiry", (req, res) => {
    const { voucher } = req.query;
    if (!voucher) return res.json({ expired: true });
    db.get(`SELECT expires_at FROM vouchers WHERE voucher = ? AND status = 'active'`, [voucher], (err, row) => {
        if (err || !row) return res.json({ expired: true });
        const expired = new Date(row.expires_at) <= new Date();
        res.json({ expired });
    });
});

// --- Webhook: MTN confirms payment ---
app.post("/mtn/webhook", (req, res) => {
    try {
        const payload = req.body;
        const paymentId = payload.externalId || payload.referenceId;

        db.get(`SELECT * FROM payments WHERE id = ?`, [paymentId], (err, payment) => {
            if (err || !payment) return res.status(404).json({ ok: false, error: "Payment not found" });

            db.run(`UPDATE payments SET status = ?, provider_ref = ? WHERE id = ?`,
                ["confirmed", payload.referenceId, paymentId]);

            const voucher = 'VCHR-' + Math.floor(100000 + Math.random() * 900000);
            const expires_at = getExpiry(payment.plan);
            const voucherId = uuidv4();

            db.run(`INSERT INTO vouchers (id, phone, plan, amount, voucher, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [voucherId, payment.phone, payment.plan, payment.amount, voucher, "active", expires_at]);

            res.json({ ok: true });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
