const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = 'mongodb+srv://m7eeekurd_db_user:m7em7em7e@%40%23%24@cluster0.dznvbna.mongodb.net/';
const PROVIDER_URL = 'https://kd1s.com/api/v2';
const API_KEY = 'e2eefe68edc8ded96efce30d0196616a';
let PROFIT_PERCENTAGE = 40;

let db, usersCollection, ordersCollection;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db('m7_store');
        usersCollection = db.collection('users');
        ordersCollection = db.collection('orders');
        console.log('Connected to MongoDB successfully!');
    } catch (err) {
        console.error('MongoDB Connection Error:', err);
    }
}
connectDB();

app.post('/api/user', async (req, res) => {
    const { telegramId, username } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, message: 'No Telegram ID' });

    let user = await usersCollection.findOne({ telegramId });
    if (!user) {
        user = { telegramId, username: username || 'User', balance: 0.00, createdAt: new Date() };
        await usersCollection.insertOne(user);
    }
    res.json({ success: true, balance: user.balance });
});

app.get('/api/services', async (req, res) => {
    try {
        const response = await axios.post(PROVIDER_URL, { key: API_KEY, action: 'services' });
        const servicesWithProfit = response.data.map(service => {
            const originalRate = parseFloat(service.rate);
            const finalRate = (originalRate + (originalRate * (PROFIT_PERCENTAGE / 100))).toFixed(3);
            return {
                id: service.service,
                name: service.name,
                category: service.category,
                rate: finalRate,
                min: service.min,
                max: service.max
            };
        });
        res.json({ success: true, services: servicesWithProfit });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

app.post('/api/order', async (req, res) => {
    const { telegramId, service, link, quantity, cost } = req.body;
    
    let user = await usersCollection.findOne({ telegramId });
    if (!user || user.balance < cost) {
        return res.json({ success: false, error: 'Balance is not enough / بالانس نینە' });
    }

    try {
        const response = await axios.post(PROVIDER_URL, {
            key: API_KEY,
            action: 'add',
            service,
            link,
            quantity
        });

        if (response.data.order) {
            await usersCollection.updateOne({ telegramId }, { $inc: { balance: -cost } });
            await ordersCollection.insertOne({ telegramId, orderId: response.data.order, service, link, quantity, cost, date: new Date() });

            res.json({ success: true, orderId: response.data.order, newBalance: user.balance - cost });
        } else {
            res.json({ success: false, error: response.data.error || 'API Error' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Order Failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('M7 Server running on port ' + PORT));
