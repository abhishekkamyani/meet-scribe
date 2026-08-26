# MeetScribe Urdu — Deployment & Distribution Guide

MeetScribe Urdu combines a **Google Meet Chrome Extension (Manifest V3)** with a lightweight **Express.js Backend Server** for secure processing and future authentication.

---

## 1. Backend Server Deployment

You can host the Express backend on any platform such as **Render**, **Railway**, **Koyeb**, **Vercel**, or run it locally.

### Option A: Local / Self-Hosted (Free & Fast)

```bash
cd "meet-scribe-extension/backend"
npm install
npm start
```
The server will run on `http://localhost:3001`.

### Option B: Deploy to Render / Railway / Koyeb

1. Push your repository to GitHub.
2. In your Render / Railway dashboard, create a **New Web Service**.
3. Set root directory to `meet-scribe-extension/backend`.
4. Set build command to `npm install` and start command to `npm start`.
5. Add Environment Variables:
   - `GEMINI_API_KEY`: Your Google Gemini API Key
   - `GROQ_API_KEY`: (Optional) Your Groq API Key
   - `PORT`: `3001` (or default assigned by host)
6. Copy your public service URL (e.g. `https://meet-scribe-backend.onrender.com`) and paste it into the extension's **Settings (⚙️)** under **Backend Server URL**.

### Option C: Deploy to Vercel (Serverless)

```bash
cd "meet-scribe-extension"
vercel
```

---

## 2. Chrome Extension Distribution

### Option A: Direct Distribution (ZIP for Team Members)

1. Package the `extension` directory:
   ```bash
   cd "meet-scribe-extension"
   zip -r meet-scribe-urdu-v1.0.0.zip extension/
   ```
2. Users can install by:
   - Going to `chrome://extensions/`
   - Enabling **Developer mode**
   - Clicking **"Load unpacked"** and selecting the unzipped `extension` folder.

### Option B: Publish to Chrome Web Store

1. Create the Web Store upload package:
   ```bash
   cd "meet-scribe-extension/extension"
   zip -r ../meet-scribe-urdu-webstore.zip ./*
   ```
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
3. Upload `meet-scribe-urdu-webstore.zip` and submit for review.
