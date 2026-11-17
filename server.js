const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

// زانیارییەکانی پەیوەستبوون بە MongoDB و KD1S
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://m7eeekurd_db_user:m7em7em7e@%40%23%24@cluster0.dznvbna.mongodb.net/';
const PROVIDER_URL = 'https://kd1s.com/api/v2';
const API_KEY = process.env.KD1S_API_KEY || 'e2eefe68edc8ded96efce30d0196616a';

const ADMIN_USER = 'm7e';
const ADMIN_PASS = 'MM77EE@#$';

let db, usersCollection, ordersCollection, settingsCollection;
let cachedRawServices = [];
let lastCacheTime = 0;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db('m7_store');
        usersCollection = db.collection('users');
        ordersCollection = db.collection('orders');
        settingsCollection = db.collection('settings');

        // دروستکردنی ڕێکخستنە سەرەتاییەکان ئەگەر نەبن
        const existingConfig = await settingsCollection.findOne({ _id: 'config' });
        if (!existingConfig) {
            await settingsCollection.insertOne({
                _id: 'config',
                profitPercentage: 40, // ٤٠٪ قازانج
                fib: '07500000000',
                usdt: 'TYourAdminWalletAddressHere...'
            });
        }
        console.log('Connected to MongoDB successfully!');
    } catch (err) {
        console.error('MongoDB Connection Error:', err);
    }
}
connectDB();

async function getConfig() {
    if (!settingsCollection) {
        return { profitPercentage: 40, fib: '07500000000', usdt: 'TYourAdminWalletAddressHere...' };
    }
    const cfg = await settingsCollection.findOne({ _id: 'config' });
    return cfg || { profitPercentage: 40, fib: '07500000000', usdt: 'TYourAdminWalletAddressHere...' };
}

async function fetchProviderServices() {
    const now = Date.now();
    if (cachedRawServices.length > 0 && (now - lastCacheTime) < 60000) {
        return cachedRawServices;
    }
    const response = await axios.post(PROVIDER_URL, { key: API_KEY, action: 'services' });
    if (Array.isArray(response.data)) {
        cachedRawServices = response.data;
        lastCacheTime = now;
    }
    return cachedRawServices;
}

// ١. وەرگرتن یان دروستکردنی هەژماری بەکارهێنەر لە MongoDB
app.post('/api/user', async (req, res) => {
    try {
        const telegramId = String(req.body.telegramId || '').trim();
        const username = req.body.username || 'User';
        if (!telegramId) return res.status(400).json({ success: false, message: 'No Telegram ID' });

        let user = await usersCollection.findOne({ telegramId });
        if (!user) {
            user = { telegramId, username, balance: 0.00, createdAt: new Date() };
            await usersCollection.insertOne(user);
        }

        const cfg = await getConfig();
        res.json({
            success: true,
            balance: parseFloat(user.balance || 0),
            settings: {
                profitPercentage: cfg.profitPercentage,
                fib: cfg.fib,
                usdt: cfg.usdt
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// ٢. هێنانی هەموو خزمەتگوزارییەکانی KD1S لەگەڵ ڕێژەی قازانج
app.get('/api/services', async (req, res) => {
    try {
        const cfg = await getConfig();
        const profitPct = parseFloat(cfg.profitPercentage) || 0;
        const rawServices = await fetchProviderServices();

        const servicesWithProfit = rawServices.map(service => {
            const originalRate = parseFloat(service.rate) || 0;
            const finalRate = (originalRate + (originalRate * (profitPct / 100))).toFixed(3);
            return {
                id: service.service,
                service: service.service,
                name: service.name,
                category: service.category,
                rate: finalRate,
                min: service.min,
                max: service.max,
                refill: service.refill
            };
        });

        res.json({ success: true, services: servicesWithProfit });
    } catch (error) {
        console.error('Services Error:', error.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// ٣. تۆمارکردنی داواکاری لە KD1S و بڕینی باڵانس لە MongoDB
app.post('/api/order', async (req, res) => {
    try {
        const telegramId = String(req.body.telegramId || '').trim();
        const serviceId = String(req.body.serviceId || req.body.service || '').trim();
        const link = String(req.body.link || '').trim();
        const quantity = parseInt(req.body.quantity, 10);

        if (!telegramId || !serviceId || !link || isNaN(quantity) || quantity <= 0) {
            return res.json({ success: false, error: 'Invalid order parameters' });
        }

        const rawServices = await fetchProviderServices();
        const targetService = rawServices.find(s => String(s.service) === serviceId);
        if (!targetService) {
            return res.json({ success: false, error: 'Service not found' });
        }

        const cfg = await getConfig();
        const profitPct = parseFloat(cfg.profitPercentage) || 0;
        const originalRate = parseFloat(targetService.rate) || 0;
        const finalRate = originalRate + (originalRate * (profitPct / 100));
        const exactCost = parseFloat(((quantity / 1000) * finalRate).toFixed(4));

        const user = await usersCollection.findOne({ telegramId });
        if (!user || parseFloat(user.balance) < exactCost) {
            return res.json({ success: false, error: 'Insufficient balance' });
        }

        // ناردنی داواکاری بۆ KD1S
        const response = await axios.post(PROVIDER_URL, {
            key: API_KEY,
            action: 'add',
            service: serviceId,
            link: link,
            quantity: quantity
        });

        if (response.data && response.data.order) {
            const newBalance = parseFloat((parseFloat(user.balance) - exactCost).toFixed(4));
            await usersCollection.updateOne({ telegramId }, { $set: { balance: newBalance } });

            const orderRecord = {
                telegramId,
                orderId: response.data.order,
                serviceId,
                serviceName: targetService.name,
                link,
                quantity,
                cost: exactCost,
                date: new Date()
            };
            await ordersCollection.insertOne(orderRecord);

            return res.json({
                success: true,
                orderId: response.data.order,
                newBalance: newBalance
            });
        } else {
            return res.json({
                success: false,
                error: (response.data && response.data.error) || 'Provider rejected order'
            });
        }
    } catch (error) {
        console.error('Order Error:', error.message);
        res.status(500).json({ success: false, error: 'Order Failed' });
    }
});

// ٤. هێنانی تۆماری داواکارییەکانی بەکارهێنەر لە MongoDB
app.get('/api/orders/:telegramId', async (req, res) => {
    try {
        const telegramId = String(req.params.telegramId || '').trim();
        const orders = await ordersCollection
            .find({ telegramId })
            .sort({ date: -1 })
            .limit(50)
            .toArray();
        res.json({ success: true, orders });
    } catch (err) {
        res.status(500).json({ success: false, orders: [] });
    }
});

// ٥. پشکنینی چوونەژوورەوەی ئەدمین
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// ٦. زیادکردنی باڵانس بۆ هەر بەکارهێنەرێک لە MongoDB لەلایەن ئەدمینەوە
app.post('/api/admin/add-balance', async (req, res) => {
    try {
        const { username, password, targetTelegramId, amount } = req.body;
        if (username !== ADMIN_USER || password !== ADMIN_PASS) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const targetId = String(targetTelegramId || '').trim();
        const addAmt = parseFloat(amount);
        if (!targetId || isNaN(addAmt)) {
            return res.json({ success: false, message: 'Invalid ID or amount' });
        }

        const existingUser = await usersCollection.findOne({ telegramId: targetId });
        let updatedBalance = addAmt;

        if (existingUser) {
            updatedBalance = parseFloat((parseFloat(existingUser.balance || 0) + addAmt).toFixed(4));
            await usersCollection.updateOne({ telegramId: targetId }, { $set: { balance: updatedBalance } });
        } else {
            await usersCollection.insertOne({
                telegramId: targetId,
                username: 'User',
                balance: updatedBalance,
                createdAt: new Date()
            });
        }

        res.json({ success: true, newBalance: updatedBalance });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ٧. گۆڕینی ڕێژەی قازانج و ژمارەکانی پارەدان لە MongoDB
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { username, password, profitPercentage, fib, usdt } = req.body;
        if (username !== ADMIN_USER || password !== ADMIN_PASS) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const profitPct = parseFloat(profitPercentage);
        await settingsCollection.updateOne(
            { _id: 'config' },
            {
                $set: {
                    profitPercentage: isNaN(profitPct) ? 40 : profitPct,
                    fib: String(fib || '').trim(),
                    usdt: String(usdt || '').trim()
                }
            },
            { upsert: true }
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('M7 Server running on port ' + PORT));
