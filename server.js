import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.BOT_TOKEN || '8854543943:AAFQ0pz_PhPqxfm9pP9G6bBBRVZ1KQLWFT4';
const CHANNEL_ID = process.env.CHANNEL_ID || '-1004293229182';
const ADMIN_KEY = process.env.ADMIN_KEY || 'alamin-boss-key-123';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('videos.json')) fs.writeFileSync('videos.json', '[]');

const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const loadVideos = () => JSON.parse(fs.readFileSync('videos.json'));
const saveVideos = (v) => fs.writeFileSync('videos.json', JSON.stringify(v, null, 2));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('video', async (msg) => {
    try {
        const title = msg.caption || 'শিরোনামহীন পট';
        const sent = await bot.forwardMessage(CHANNEL_ID, msg.chat.id, msg.message_id);
        const videos = loadVideos();
        videos.push({
            id: Date.now(), title, desc: msg.caption || '', cat: 'সাধারণ',
            tgFileId: sent.video.file_id,
            date: new Date().toISOString(), source: 'telegram'
        });
        saveVideos(videos);
        bot.sendMessage(msg.chat.id, `✅ সংরক্ষিত: ${title}`);
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

function checkAdmin(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (key !== ADMIN_KEY) return res.status(401).json({ error: 'অনুমতি নেই' });
    next();
}

app.get('/api/videos', (req, res) => {
    const videos = loadVideos();
    const safe = videos.map(v => ({
        id: v.id, title: v.title, desc: v.desc, cat: v.cat,
        date: v.date, source: v.source,
        thumbUrl: v.thumbFile ? `/uploads/${v.thumbFile}` : null,
        streamUrl: `/api/stream/${v.id}`
    }));
    res.json(safe);
});

app.get('/api/stream/:id', async (req, res) => {
    const video = loadVideos().find(v => v.id == req.params.id);
    if (!video) return res.status(404).send('পাওয়া যায়নি');

    if (video.source === 'telegram' && video.tgFileId) {
        try {
            const link = await bot.getFileLink(video.tgFileId);
            return res.redirect(link);
        } catch (err) {
            return res.status(500).send('টেলিগ্রাম সমস্যা: ' + err.message);
        }
    }
    if (video.videoFile) return res.sendFile(path.resolve('uploads/' + video.videoFile));
    res.status(404).send('ফাইল নেই');
});

app.post('/api/admin/upload',
    checkAdmin,
    upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
    async (req, res) => {
        try {
            const { title, desc, cat, videoUrl } = req.body;
            if (!title) return res.status(400).json({ error: 'শিরোনাম দিন' });
            const videoFile = req.files?.video?.[0];
            const thumbFile = req.files?.thumb?.[0];
            if (!videoFile && !videoUrl) return res.status(400).json({ error: 'ভিডিও দিন' });

            const newVideo = {
                id: Date.now(), title, desc: desc || '', cat: cat || 'সাধারণ',
                date: new Date().toISOString(),
                source: videoFile ? 'file' : 'url',
                videoFile: videoFile ? videoFile.filename : null,
                thumbFile: thumbFile ? thumbFile.filename : null,
                videoUrl: videoUrl || null
            };
            const videos = loadVideos();
            videos.push(newVideo);
            saveVideos(videos);
            res.json({ success: true, video: newVideo });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

app.delete('/api/admin/video/:id', checkAdmin, (req, res) => {
    const videos = loadVideos();
    const video = videos.find(v => v.id == req.params.id);
    if (!video) return res.status(404).json({ error: 'পাওয়া যায়নি' });
    if (video.videoFile) { try { fs.unlinkSync('uploads/' + video.videoFile); } catch (e) {} }
    if (video.thumbFile) { try { fs.unlinkSync('uploads/' + video.thumbFile); } catch (e) {} }
    saveVideos(videos.filter(v => v.id != req.params.id));
    res.json({ success: true });
});

app.put('/api/admin/video/:id', checkAdmin, (req, res) => {
    const videos = loadVideos();
    const video = videos.find(v => v.id == req.params.id);
    if (!video) return res.status(404).json({ error: 'পাওয়া যায়নি' });
    if (req.body.title) video.title = req.body.title;
    if (req.body.desc !== undefined) video.desc = req.body.desc;
    if (req.body.cat) video.cat = req.body.cat;
    saveVideos(videos);
    res.json({ success: true, video });
});

app.get('/', (req, res) => {
    res.json({ status: 'running', totalVideos: loadVideos().length });
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ সার্ভার চালু: পোর্ট ${PORT}`));