const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const KD1S_API_KEY = process.env.KD1S_API_KEY;
const KD1S_API_URL = 'https://kd1s.com/api/v2';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456';

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB Error:', err));

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: String,
    firstName: String,
    balance: { type: Number, default: 0 }
});

const orderSchema = new mongoose.Schema({
    telegramId: String,
    username: String,
    orderId: String,
    serviceId: String,
    serviceName: String,
    link: String,
    quantity: Number,
    cost: Number,
    status: { type: String, default: 'In Progress' },
    createdAt: { type: Date, default: Date.now }
});

const settingsSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    profitPercentage: { type: Number, default: 40 },
    qicard: { type: String, default: '0000000000' },
    usdt: { type: String, default: 'TYourAdminWalletAddressHere...' },
    botToken: { type: String, default: '' },
    adminChatId: { type: String, default: '' },
    approvalMode: { type: String, default: 'auto' }
});

const User = mongoose.model('User', userSchema);
const Order = mongoose.model('Order', orderSchema);
const Settings = mongoose.model('Settings', settingsSchema);

async function getSettings() {
    let s = await Settings.findOne({ key: 'main' });
    if (!s) {
        s = await Settings.create({ key: 'main' });
    }
    return s;
}

async function sendTelegramAlert(botToken, chatId, htmlText) {
    if (!botToken || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: htmlText,
                parse_mode: 'HTML'
            })
        });
    } catch (err) {
        console.error('Telegram Notify Error:', err.message);
    }
}

function checkAdmin(username, password) {
    return username === ADMIN_USER && password === ADMIN_PASS;
}

app.get('/', (req, res) => {
    res.send('M7 Store Server is Running!');
});

// Sync User & Public Settings
app.post('/api/user', async (req, res) => {
    try {
        const { telegramId, username, firstName } = req.body;
        if (!telegramId) return res.json({ success: false });

        let user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) {
            user = await User.create({
                telegramId: String(telegramId),
                username: username || '',
                firstName: firstName || '',
                balance: 0
            });
        } else {
            user.username = username || user.username;
            user.firstName = firstName || user.firstName;
            await user.save();
        }

        const s = await getSettings();
        res.json({
            success: true,
            balance: user.balance,
            settings: {
                profitPercentage: s.profitPercentage,
                qicard: s.qicard,
                usdt: s.usdt,
                approvalMode: s.approvalMode
            }
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Fetch KD1S Services with Profit Margin
app.get('/api/services', async (req, res) => {
    try {
        const s = await getSettings();
        const profit = Number(s.profitPercentage) || 0;

        const response = await fetch(KD1S_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: KD1S_API_KEY, action: 'services' })
        });
        const rawServices = await response.json();

        if (!Array.isArray(rawServices)) {
            return res.json({ success: false, error: 'Failed to load services' });
        }

        const services = rawServices.map(srv => {
            const baseRate = parseFloat(srv.rate) || 0;
            const finalRate = baseRate * (1 + profit / 100);
            return {
                ...srv,
                rate: finalRate.toFixed(4)
            };
        });

        res.json({ success: true, services });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Create New Order
app.post('/api/order', async (req, res) => {
    try {
        const { telegramId, username, serviceId, link, quantity } = req.body;
        const user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) return res.json({ success: false, error: 'User not found!' });

        const s = await getSettings();
        const profit = Number(s.profitPercentage) || 0;

        const srvRes = await fetch(KD1S_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: KD1S_API_KEY, action: 'services' })
        });
        const rawServices = await srvRes.json();
        const targetSrv = Array.isArray(rawServices)
            ? rawServices.find(item => String(item.service) === String(serviceId))
            : null;

        if (!targetSrv) return res.json({ success: false, error: 'Service not found!' });

        const baseRate = parseFloat(targetSrv.rate) || 0;
        const finalRate = baseRate * (1 + profit / 100);
        const cost = parseFloat(((Number(quantity) / 1000) * finalRate).toFixed(4));

        if (user.balance < cost) {
            return res.json({ success: false, error: 'Insufficient balance!' });
        }

        // Manual Approval Mode
        if (s.approvalMode === 'manual') {
            await Order.create({
                telegramId: String(telegramId),
                username: username || '',
                orderId: 'PENDING',
                serviceId: String(serviceId),
                serviceName: targetSrv.name || '',
                link,
                quantity: Number(quantity),
                cost,
                status: 'Pending'
            });

            await sendTelegramAlert(
                s.botToken,
                s.adminChatId,
                `⏳ <b>طلب جديد بانتظار الموافقة (M7 Store)</b>\n\n` +
                `👤 <b>المستخدم:</b> ${username || 'User'}\n` +
                `🆔 <b>ID:</b> <code>${telegramId}</code>\n` +
                `📦 <b>الخدمة:</b> #${serviceId} - ${targetSrv.name}\n` +
                `🔢 <b>الكمية:</b> ${quantity}\n` +
                `💵 <b>التكلفة:</b> $${cost}\n` +
                `🔗 <b>الرابط:</b> ${link}`
            );

            return res.json({ success: true, pending: true, newBalance: user.balance });
        }

        // Auto Execution Mode
        const kdRes = await fetch(KD1S_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: KD1S_API_KEY,
                action: 'add',
                service: serviceId,
                link,
                quantity
            })
        });
        const kdData = await kdRes.json();

        if (!kdData || !kdData.order) {
            return res.json({ success: false, error: kdData?.error || 'Provider order failed!' });
        }

        user.balance = parseFloat((user.balance - cost).toFixed(4));
        await user.save();

        await Order.create({
            telegramId: String(telegramId),
            username: username || '',
            orderId: String(kdData.order),
            serviceId: String(serviceId),
            serviceName: targetSrv.name || '',
            link,
            quantity: Number(quantity),
            cost,
            status: 'In Progress'
        });

        await sendTelegramAlert(
            s.botToken,
            s.adminChatId,
            `⚡ <b>طلب جديد تم تنفيذه (M7 Store)</b>\n\n` +
            `🆔 <b>رقم الطلب:</b> #${kdData.order}\n` +
            `👤 <b>المستخدم:</b> ${username || 'User'}\n` +
            `🆔 <b>User ID:</b> <code>${telegramId}</code>\n` +
            `📦 <b>الخدمة:</b> ${targetSrv.name}\n` +
            `🔢 <b>الكمية:</b> ${quantity}\n` +
            `💵 <b>المبلغ المخصوم:</b> $${cost}\n` +
            `🔗 <b>الرابط:</b> ${link}`
        );

        res.json({ success: true, orderId: kdData.order, newBalance: user.balance });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// User Order History
app.get('/api/orders/:telegramId', async (req, res) => {
    try {
        const orders = await Order.find({ telegramId: String(req.params.telegramId) })
            .sort({ createdAt: -1 })
            .limit(30);
        res.json({ success: true, orders });
    } catch (err) {
        res.json({ success: false, orders: [] });
    }
});

// Top-Up Request Notification
app.post('/api/refill-request', async (req, res) => {
    try {
        const { telegramId, username, method, amount, note } = req.body;
        const s = await getSettings();

        await sendTelegramAlert(
            s.botToken,
            s.adminChatId,
            `💳 <b>طلب شحن رصيد جديد (M7 Store)</b>\n\n` +
            `👤 <b>المستخدم:</b> ${username || 'User'}\n` +
            `🆔 <b>ID (اضغط للنسخ):</b> <code>${telegramId}</code>\n` +
            `💰 <b>المبلغ:</b> $${amount}\n` +
            `🏦 <b>الطريقة:</b> ${method}\n` +
            `📝 <b>ملاحظة / رقم الحوالة:</b> ${note || 'لا يوجد'}`
        );

        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!checkAdmin(username, password)) {
            return res.json({ success: false });
        }
        const settings = await getSettings();
        const pendingOrders = await Order.find({ status: 'Pending' }).sort({ createdAt: -1 });
        res.json({ success: true, settings, pendingOrders });
    } catch (err) {
        res.json({ success: false });
    }
});

// Save Admin Settings
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { username, password, profitPercentage, qicard, usdt, botToken, adminChatId, approvalMode } = req.body;
        if (!checkAdmin(username, password)) {
            return res.json({ success: false, message: 'Unauthorized' });
        }

        const parsedProfit = Number(profitPercentage);
        const s = await getSettings();
        s.profitPercentage = isNaN(parsedProfit) ? 40 : parsedProfit;
        s.qicard = qicard !== undefined ? String(qicard) : s.qicard;
        s.usdt = usdt !== undefined ? String(usdt) : s.usdt;
        s.botToken = botToken !== undefined ? String(botToken).trim() : s.botToken;
        s.adminChatId = adminChatId !== undefined ? String(adminChatId).trim() : s.adminChatId;
        s.approvalMode = approvalMode || 'auto';

        await s.save();
        res.json({ success: true, settings: s });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// Admin Add Balance by User ID
app.post('/api/admin/add-balance', async (req, res) => {
    try {
        const { username, password, targetTelegramId, amount } = req.body;
        if (!checkAdmin(username, password)) {
            return res.json({ success: false, message: 'Unauthorized' });
        }

        const addVal = parseFloat(amount);
        if (!targetTelegramId || isNaN(addVal)) {
            return res.json({ success: false, message: 'Invalid ID or amount' });
        }

        let user = await User.findOne({ telegramId: String(targetTelegramId) });
        if (!user) {
            user = await User.create({
                telegramId: String(targetTelegramId),
                balance: 0
            });
        }

        user.balance = parseFloat((user.balance + addVal).toFixed(4));
        await user.save();

        const s = await getSettings();
        await sendTelegramAlert(
            s.botToken,
            String(targetTelegramId),
            `✅ <b>تم شحن رصيدك في M7 Store!</b>\n\n` +
            `💵 <b>المبلغ المضاف:</b> $${addVal}\n` +
            `💰 <b>رصيدك الحالي:</b> $${user.balance.toFixed(2)}`
        );

        res.json({ success: true, newBalance: user.balance });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// Admin Approve or Reject Pending Order
app.post('/api/admin/order-action', async (req, res) => {
    try {
        const { username, password, orderDbId, action } = req.body;
        if (!checkAdmin(username, password)) {
            return res.json({ success: false, message: 'Unauthorized' });
        }

        const order = await Order.findById(orderDbId);
        if (!order || order.status !== 'Pending') {
            return res.json({ success: false, message: 'Order not found or already processed' });
        }

        const s = await getSettings();

        if (action === 'reject') {
            order.status = 'Rejected';
            await order.save();
            await sendTelegramAlert(s.botToken, order.telegramId, `❌ تم رفض طلبك للخدمة: ${order.serviceName}`);
            return res.json({ success: true });
        }

        const user = await User.findOne({ telegramId: order.telegramId });
        if (!user || user.balance < order.cost) {
            return res.json({ success: false, message: 'User balance is insufficient!' });
        }

        const kdRes = await fetch(KD1S_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: KD1S_API_KEY,
                action: 'add',
                service: order.serviceId,
                link: order.link,
                quantity: order.quantity
            })
        });
        const kdData = await kdRes.json();

        if (!kdData || !kdData.order) {
            return res.json({ success: false, message: kdData?.error || 'Provider failed!' });
        }

        user.balance = parseFloat((user.balance - order.cost).toFixed(4));
        await user.save();

        order.orderId = String(kdData.order);
        order.status = 'In Progress';
        await order.save();

        await sendTelegramAlert(
            s.botToken,
            order.telegramId,
            `✅ <b>تمت الموافقة على طلبك وتنفيذه!</b>\n🆔 رقم الطلب: #${kdData.order}`
        );

        res.json({ success: true, orderId: kdData.order });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
                                  
