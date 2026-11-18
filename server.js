const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://m7eeekurd_db_user:m7em7em7e@%40%23%24@cluster0.dznvbna.mongodb.net/';
const PROVIDER_URL = 'https://kd1s.com/api/v2';
const API_KEY = process.env.KD1S_API_KEY || 'e2eefe68edc8ded96efce30d0196616a';

const ADMIN_USER = 'm7e';
const ADMIN_PASS = 'MM77EE@#$';

let db, usersCollection, ordersCollection, refillsCollection, settingsCollection;
let cachedRawServices = [];
let lastCacheTime = 0;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db('m7_store');
        usersCollection = db.collection('users');
        ordersCollection = db.collection('orders');
        refillsCollection = db.collection('refills');
        settingsCollection = db.collection('settings');

        const existingConfig = await settingsCollection.findOne({ _id: 'config' });
        if (!existingConfig) {
            await settingsCollection.insertOne({
                _id: 'config',
                profitPercentage: 40,
                qicard: '0000000000',
                usdt: 'TYourAdminWalletAddressHere...',
                botToken: process.env.BOT_TOKEN || '',
                adminChatId: process.env.ADMIN_ID || '',
                approvalMode: 'auto' // 'auto' = جێبەجێکرنا ئۆتۆماتیک ل KD1S, 'manual' = پەسەندکرنا ئەدمینی
            });
        }
        console.log('Connected to MongoDB successfully!');
    } catch (err) {
        console.error('MongoDB Connection Error:', err);
    }
}
connectDB();

async function getConfig() {
    const fallback = {
        profitPercentage: 40,
        qicard: '0000000000',
        usdt: 'TYourAdminWalletAddressHere...',
        botToken: process.env.BOT_TOKEN || '',
        adminChatId: process.env.ADMIN_ID || '',
        approvalMode: 'auto'
    };
    if (!settingsCollection) return fallback;
    const cfg = await settingsCollection.findOne({ _id: 'config' });
    return { ...fallback, ...(cfg || {}) };
}

async function sendTelegramMessage(chatId, text, customToken) {
    try {
        const cfg = await getConfig();
        const token = (customToken || cfg.botToken || process.env.BOT_TOKEN || '').trim();
        const target = String(chatId || '').trim();
        if (!token || !target) return;

        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: target,
            text: text,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error('Telegram Notify Error:', err.message);
    }
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

// ١. وەرگرتن یان دروستکرنا حسابێ بەکارهێنەری ب Telegram ID
app.post('/api/user', async (req, res) => {
    try {
        const telegramId = String(req.body.telegramId || '').trim();
        const username = req.body.username || 'User';
        const firstName = req.body.firstName || username;
        if (!telegramId) return res.status(400).json({ success: false, message: 'No Telegram ID' });

        let user = await usersCollection.findOne({ telegramId });
        if (!user) {
            user = {
                telegramId,
                username,
                firstName,
                balance: 0.00,
                createdAt: new Date()
            };
            await usersCollection.insertOne(user);
        } else if (username && user.username !== username) {
            await usersCollection.updateOne({ telegramId }, { $set: { username, firstName } });
        }

        const cfg = await getConfig();
        res.json({
            success: true,
            balance: parseFloat(user.balance || 0),
            settings: {
                profitPercentage: cfg.profitPercentage,
                qicard: cfg.qicard,
                usdt: cfg.usdt,
                approvalMode: cfg.approvalMode
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// ٢. ئینانا هەموو خزمەتگوزاریێن KD1S
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
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// ٣. داواکرنا خزمەتگوزاریێ + ئاگەهداریا تیلیگرامی + بڕینا پارەی ل دەمێ جێبەجێکرنێ
app.post('/api/order', async (req, res) => {
    try {
        const telegramId = String(req.body.telegramId || '').trim();
        const username = String(req.body.username || 'User').trim();
        const serviceId = String(req.body.serviceId || '').trim();
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

        // ئەگەر سیستەم ل سەر پەسەندکرنا ئەدمینی بیت (manual)
        if (cfg.approvalMode === 'manual') {
            const pendingOrder = {
                telegramId,
                username,
                orderId: 'PENDING-' + Math.floor(100000 + Math.random() * 900000),
                serviceId,
                serviceName: targetService.name,
                link,
                quantity,
                cost: exactCost,
                status: 'Pending Approval',
                charged: false,
                date: new Date()
            };
            await ordersCollection.insertOne(pendingOrder);

            await sendTelegramMessage(
                cfg.adminChatId,
                `🔔 <b>طلب خدمة جديد (بانتظار موافقتك)</b>\n\n` +
                `👤 المستخدم: @${username}\n` +
                `🆔 الأيدي: <code>${telegramId}</code>\n` +
                `📦 الخدمة: #${serviceId} - ${targetService.name}\n` +
                `🔗 الرابط: ${link}\n` +
                `🔢 الكمية: ${quantity}\n` +
                `💵 التكلفة: <b>$${exactCost}</b>\n\n` +
                `⚙️ افتح لوحة التحكم في التطبيق للموافقة وخصم الرصيد.`
            );

            return res.json({
                success: true,
                pending: true,
                orderId: pendingOrder.orderId,
                newBalance: parseFloat(user.balance)
            });
        }

        // جێبەجێکرنا ڕاستەوخۆ ل KD1S
        const response = await axios.post(PROVIDER_URL, {
            key: API_KEY,
            action: 'add',
            service: serviceId,
            link: link,
            quantity: quantity
        });

        // دەمێ داواکاری دچیتە بارێ جێبەجێکرنێ دا، ئێکسەر پارە ژ حسابێ وی دهێتە بڕین
        if (response.data && response.data.order) {
            const newBalance = parseFloat((parseFloat(user.balance) - exactCost).toFixed(4));
            await usersCollection.updateOne({ telegramId }, { $set: { balance: newBalance } });

            const orderRecord = {
                telegramId,
                username,
                orderId: response.data.order,
                serviceId,
                serviceName: targetService.name,
                link,
                quantity,
                cost: exactCost,
                status: 'In Progress',
                charged: true,
                date: new Date()
            };
            await ordersCollection.insertOne(orderRecord);

            await sendTelegramMessage(
                cfg.adminChatId,
                `⚡ <b>طلب خدمة جديد (قيد التنفيذ)</b>\n\n` +
                `👤 المستخدم: @${username}\n` +
                `🆔 الأيدي: <code>${telegramId}</code>\n` +
                `🆔 رقم الطلب: <b>#${response.data.order}</b>\n` +
                `📦 الخدمة: ${targetService.name}\n` +
                `🔗 الرابط: ${link}\n` +
                `🔢 الكمية: ${quantity}\n` +
                `💵 المبلغ المخصوم: <b>$${exactCost}</b>\n` +
                `💰 الرصيد المتبقي: $${newBalance.toFixed(2)}`
            );

            return res.json({
                success: true,
                orderId: response.data.order,
                newBalance: newBalance
            });
        } else {
            // ئەگەر KD1S پەسەند نەکر، وەک Pending تۆمار دکەت بێی بڕینا پارەی دا ئەدمین ببینیت
            const fallbackOrder = {
                telegramId,
                username,
                orderId: 'HOLD-' + Math.floor(100000 + Math.random() * 900000),
                serviceId,
                serviceName: targetService.name,
                link,
                quantity,
                cost: exactCost,
                status: 'Pending Approval',
                charged: false,
                providerNote: (response.data && response.data.error) || 'Needs approval',
                date: new Date()
            };
            await ordersCollection.insertOne(fallbackOrder);

            await sendTelegramMessage(
                cfg.adminChatId,
                `⚠️ <b>طلب معلق يحتاج موافقتك</b>\n\n` +
                `👤 المستخدم: @${username}\n` +
                `🆔 الأيدي: <code>${telegramId}</code>\n` +
                `📦 الخدمة: #${serviceId} - ${targetService.name}\n` +
                `🔗 الرابط: ${link}\n` +
                `🔢 الكمية: ${quantity}\n` +
                `💵 التكلفة: $${exactCost}\n` +
                `📝 السبب: ${fallbackOrder.providerNote}`
            );

            return res.json({
                success: true,
                pending: true,
                orderId: fallbackOrder.orderId,
                newBalance: parseFloat(user.balance)
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Order Failed' });
    }
});

// ٤. داخوازا شەحنکرنێ (QiCard یان USDT TRC20) + ئاگەهداریا ڕاستەوخۆ بۆ ئەدمینی
app.post('/api/refill-request', async (req, res) => {
    try {
        const telegramId = String(req.body.telegramId || '').trim();
        const username = String(req.body.username || 'User').trim();
        const method = String(req.body.method || 'QiCard').trim();
        const amount = parseFloat(req.body.amount);
        const note = String(req.body.note || '').trim();

        if (!telegramId || isNaN(amount) || amount <= 0) {
            return res.json({ success: false, error: 'Invalid refill amount' });
        }

        const refillDoc = {
            telegramId,
            username,
            method,
            amount,
            note,
            status: 'Pending',
            date: new Date()
        };
        await refillsCollection.insertOne(refillDoc);

        const cfg = await getConfig();
        await sendTelegramMessage(
            cfg.adminChatId,
            `💳 <b>طلب شحن رصيد جديد (M7 Store)</b>\n\n` +
            `👤 المستخدم: @${username}\n` +
            `🆔 الأيدي (اضغط للنسخ): <code>${telegramId}</code>\n` +
            `💰 المبلغ المطلوب: <b>$${amount}</b>\n` +
            `🏦 طريقة الدفع: <b>${method}</b>\n` +
            (note ? `📝 ملاحظة / رقم العملية: ${note}\n` : '') +
            `\n⚙️ لإضافة الرصيد افتح التطبيق -> Admin Panel واكتب الأيدي أعلاه.`
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Refill request failed' });
    }
});

// ٥. تۆمارێن داواکاریان بۆ بەکارهێنەری
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

// ٦. چوونەژوورەوەی ئەدمین
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const cfg = await getConfig();
        const pendingOrders = await ordersCollection
            .find({ status: 'Pending Approval' })
            .sort({ date: -1 })
            .limit(30)
            .toArray();
        return res.json({ success: true, settings: cfg, pendingOrders });
    }
    res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// ٧. زێدەکرنا باڵانسی ب رێکا Telegram ID ژ لایێ ئەدمینی ڤە
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

        await sendTelegramMessage(
            targetId,
            `✅ <b>تم شحن رصيدك بنجاح!</b>\n\n` +
            `💰 المبلغ المضاف: <b>$${addAmt.toFixed(2)}</b>\n` +
            `🏦 رصيدك الحالي: <b>$${updatedBalance.toFixed(2)}</b>`
        );

        res.json({ success: true, newBalance: updatedBalance });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ٨. پەسەندکرن یان ڕەتکرنا داواکاریێن هەلاویستی ژ لایێ ئەدمینی ڤە + بڕینا پارەی
app.post('/api/admin/order-action', async (req, res) => {
    try {
        const { username, password, orderDbId, action } = req.body;
        if (username !== ADMIN_USER || password !== ADMIN_PASS) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const order = await ordersCollection.findOne({ _id: new ObjectId(orderDbId) });
        if (!order) return res.json({ success: false, message: 'Order not found' });

        if (action === 'reject') {
            await ordersCollection.updateOne(
                { _id: order._id },
                { $set: { status: 'Rejected' } }
            );
            return res.json({ success: true });
        }

        if (action === 'approve') {
            const user = await usersCollection.findOne({ telegramId: order.telegramId });
            if (!user || parseFloat(user.balance) < parseFloat(order.cost)) {
                return res.json({ success: false, message: 'User balance is insufficient!' });
            }

            const providerRes = await axios.post(PROVIDER_URL, {
                key: API_KEY,
                action: 'add',
                service: order.serviceId,
                link: order.link,
                quantity: order.quantity
            });

            if (providerRes.data && providerRes.data.order) {
                const newBalance = parseFloat((parseFloat(user.balance) - parseFloat(order.cost)).toFixed(4));
                await usersCollection.updateOne({ telegramId: order.telegramId }, { $set: { balance: newBalance } });
                await ordersCollection.updateOne(
                    { _id: order._id },
                    {
                        $set: {
                            orderId: providerRes.data.order,
                            status: 'In Progress',
                            charged: true
                        }
                    }
                );

                await sendTelegramMessage(
                    order.telegramId,
                    `🚀 <b>تمت الموافقة على طلبك وبدأ التنفيذ!</b>\n\n` +
                    `🆔 رقم الطلب: <b>#${providerRes.data.order}</b>\n` +
                    `📦 الخدمة: ${order.serviceName}\n` +
                    `💵 المبلغ المخصوم: <b>$${order.cost}</b>`
                );

                return res.json({ success: true, orderId: providerRes.data.order });
            } else {
                return res.json({
                    success: false,
                    message: (providerRes.data && providerRes.data.error) || 'KD1S rejected order'
                });
            }
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Action failed' });
    }
});

// ٩. پاشەکەوتکرنا ڕێکخستنێن ئەدمینی (QiCard, USDT, قازانج, Bot Token, Admin ID)
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { username, password, profitPercentage, qicard, usdt, botToken, adminChatId, approvalMode } = req.body;
        if (username !== ADMIN_USER || password !== ADMIN_PASS) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const profitPct = parseFloat(profitPercentage);
        await settingsCollection.updateOne(
            { _id: 'config' },
            {
                $set: {
                    profitPercentage: isNaN(profitPct) ? 40 : profitPct,
                    qicard: String(qicard || '').trim(),
                    usdt: String(usdt || '').trim(),
                    botToken: String(botToken || '').trim(),
                    adminChatId: String(adminChatId || '').trim(),
                    approvalMode: approvalMode === 'manual' ? 'manual' : 'auto'
                }
            },
            { upsert: true }
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server e
