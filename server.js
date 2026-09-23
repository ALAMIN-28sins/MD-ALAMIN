require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const PORT      = process.env.PORT || 3000;
const BASE_URL  = process.env.BASE_URL || `http://localhost:${PORT}`;
const API       = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ .env এ BOT_TOKEN বা CHAT_ID নেই');
    process.exit(1);
}

/* ফাইল আপলোড */
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.mp4';
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

/* ডাটা স্টোর */
const DATA_FILE = path.join(__dirname, 'videos.json');
function loadVideos() {
    try {
        if (!fs.existsSync(DATA_FILE)) return [];
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { return []; }
}
function saveVideos(v) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(v, null, 2));
}

/* Telegram হেল্পার */
async function sendTelegramMessage(text) {
    try {
        await axios.post(`${API}/sendMessage`, {
            chat_id: CHAT_ID, text, parse_mode: 'HTML'
        });
    } catch (e) { console.warn('TG msg:', e.message); }
}

async function getTelegramFileUrl(fileId) {
    try {
        const r = await axios.get(`${API}/getFile?file_id=${fileId}`);
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${r.data.result.file_path}`;
    } catch { return null; }
}

/* ===== CORS ===== */
app.use(cors({
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

/* ===== API Routes ===== */

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'TG Video API চলছে',
        endpoints: [
            'GET  /api/health',
            'GET  /api/videos',
            'POST /api/upload-url',
            'POST /api/upload-file',
            'PUT  /api/videos/:id',
            'DELETE /api/videos/:id',
            'GET  /api/stream/:id',
            'GET  /api/set-webhook',
            'GET  /api/webhook-info'
        ]
    });
});

app.get('/api/videos', (req, res) => res.json(loadVideos()));

app.post('/api/upload-url', async (req, res) => {
    try {
        const { title, desc, videoUrl, isDrive } = req.body;
        if (!title) return res.status(400).json({ error: 'শিরোনাম দিন' });
        if (!videoUrl) return res.status(400).json({ error: 'লিংক দিন' });

        const videos = loadVideos();
        const v = {
            id: Date.now(), title: title.trim(),
            desc: (desc || '').trim(),
            date: new Date().toISOString(),
            videoUrl: videoUrl.trim(),
            isDrive: !!isDrive, isTelegram: false,
            source: isDrive ? 'drive' : 'url',
            videoFileName: isDrive ? 'Drive ভিডিও' : 'URL ভিডিও'
        };
        videos.unshift(v);
        saveVideos(videos);
        await sendTelegramMessage(`🎬 নতুন: <b>${title}</b>\n\n${desc || ''}`);
        res.json({ success: true, video: v });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/upload-file', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'ফাইল নেই' });
        const { title, desc } = req.body;
        if (!title) return res.status(400).json({ error: 'শিরোনাম দিন' });

        const isLarge = req.file.size > 50 * 1024 * 1024;
        const method = isLarge ? 'sendDocument' : 'sendVideo';

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('caption', `🎬 <b>${title}</b>\n\n${desc || ''}`);
        form.append('parse_mode', 'HTML');
        if (!isLarge) form.append('supports_streaming', 'true');
        form.append(isLarge ? 'document' : 'video',
            fs.createReadStream(req.file.path),
            { filename: req.file.originalname, contentType: req.file.mimetype }
        );

        const tg = await axios.post(`${API}/${method}`, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 10 * 60 * 1000
        });

        const result = tg.data.result;
        const fileId = (result.video || result.document).file_id;

        const videos = loadVideos();
        const v = {
            id: Date.now(), title: title.trim(),
            desc: (desc || '').trim(),
            date: new Date().toISOString(),
            videoUrl: `/uploads/${path.basename(req.file.path)}`,
            telegramFileId: fileId,
            telegramMessageId: result.message_id,
            isDrive: false, isTelegram: true,
            source: 'file',
            videoFileName: req.file.originalname
        };
        videos.unshift(v);
        saveVideos(videos);
        res.json({ success: true, video: v });
    } catch (e) {
        console.error('File upload:', e.response?.data || e.message);
        if (req.file?.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch {}
        }
        res.status(500).json({
            error: e.response?.data?.description || e.message
        });
    }
});

app.put('/api/videos/:id', (req, res) => {
    const videos = loadVideos();
    const i = videos.findIndex(v => v.id == req.params.id);
    if (i === -1) return res.status(404).json({ error: 'পাওয়া যায়নি' });
    if (req.body.title !== undefined) videos[i].title = req.body.title;
    if (req.body.desc !== undefined) videos[i].desc = req.body.desc;
    saveVideos(videos);
    res.json({ success: true, video: videos[i] });
});

app.delete('/api/videos/:id', async (req, res) => {
    let videos = loadVideos();
    const v = videos.find(x => x.id == req.params.id);
    if (v?.videoUrl?.startsWith('/uploads/')) {
        const fp = path.join(__dirname, v.videoUrl);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    }
    if (v?.telegramMessageId) {
        try {
            await axios.post(`${API}/deleteMessage`, {
                chat_id: CHAT_ID, message_id: v.telegramMessageId
            });
        } catch {}
    }
    videos = videos.filter(x => x.id != req.params.id);
    saveVideos(videos);
    res.json({ success: true });
});

app.get('/api/stream/:id', async (req, res) => {
    const v = loadVideos().find(x => x.id == req.params.id);
    if (!v) return res.status(404).json({ error: 'পাওয়া যায়নি' });
    if (v.videoUrl?.startsWith('/uploads/'))
        return res.json({ url: v.videoUrl, type: 'local' });
    if (v.telegramFileId) {
        const url = await getTelegramFileUrl(v.telegramFileId);
        return res.json({ url, type: 'telegram' });
    }
    res.json({ url: v.videoUrl, type: 'external' });
});

app.post('/api/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const msg = req.body.message || req.body.channel_post;
        if (!msg) return;
        let fileId = null, title = '';
        const desc = msg.caption || '';
        if (msg.video) {
            fileId = msg.video.file_id;
            title = desc.split('\n')[0]?.trim() || 'টেলিগ্রাম ভিডিও';
        } else if (msg.document?.mime_type?.startsWith('video/')) {
            fileId = msg.document.file_id;
            title = msg.document.file_name || 'টেলিগ্রাম ভিডিও';
        } else return;

        const url = await getTelegramFileUrl(fileId);
        if (!url) return;

        const videos = loadVideos();
        if (videos.some(v => v.telegramFileId === fileId)) return;

        videos.unshift({
            id: Date.now(), title, desc,
            date: new Date().toISOString(),
            videoUrl: url, telegramFileId: fileId,
            telegramMessageId: msg.message_id,
            isDrive: false, isTelegram: true,
            source: 'telegram', videoFileName: 'Telegram ভিডিও'
        });
        saveVideos(videos);
        await sendTelegramMessage(`✅ সেভ: <b>${title}</b>`);
    } catch (e) { console.error(e); }
});

app.get('/api/set-webhook', async (req, res) => {
    const url = req.query.url || `${BASE_URL}/api/telegram-webhook`;
    try {
        const r = await axios.get(`${API}/setWebhook?url=${encodeURIComponent(url)}`);
        res.json({ ...r.data, webhook: url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/webhook-info', async (req, res) => {
    try { res.json((await axios.get(`${API}/getWebhookInfo`)).data); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
    try {
        const me = await axios.get(`${API}/getMe`);
        res.json({
            ok: true, bot: me.data.result.username,
            videos: loadVideos().length,
            time: new Date().toISOString()
        });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`✅ সার্ভার: ${BASE_URL}`);
});