# MeetScribe Urdu (میٹ اسکرائب اردو)
### AI-Powered Google Meet Captions Transcriber & Bilingual Meeting Notes Generator

MeetScribe Urdu is a Chrome Manifest V3 extension with an Express.js backend that captures **100% ground-truth Google Meet live captions** for flawless speaker attribution, records meeting audio **locally** (`0_meeting_audio.webm` saved directly to disk with zero cloud audio upload), and processes bilingual Urdu/English speech with **Google Gemini AI** to produce organized meeting notes.

---

## 📁 Project Structure

```text
meet-scribe-extension/
├── backend/
│   ├── server.js           # Express.js backend (Captions structuring & Auth scaffolding)
│   ├── package.json        # Dependencies (Express, @google/generative-ai, Groq, CORS)
│   ├── .env.example        # Environment variables template
│   └── vercel.json         # Vercel serverless deployment configuration
└── extension/
    ├── manifest.json       # Chrome Manifest V3 configuration
    ├── popup.html          # Modern dark-mode UI with Urdu Nastaliq typography
    ├── popup.js            # UI state manager & backend health checker
    ├── popup.css           # Styling system & responsive animations
    ├── content.js          # Google Meet captions scraper & CC auto-enabler
    ├── background.js       # Service worker: pipeline coordinator & downloads
    ├── offscreen.html      # Offscreen audio recording container
    ├── offscreen.js        # Dual-channel audio recorder & instant local downloader
    ├── permission.html     # Dedicated permission request handler
    └── icons/              # Extension icons (16px, 48px, 128px)
```

---

## 🚀 Quick Start Guide

### 1. Start the Express Backend

```bash
cd meet-scribe-extension/backend
npm install
npm start
```

The backend will start at `http://localhost:3000`.  
- **Health Check**: `http://localhost:3000/api/health`
- **Captions Processing**: `http://localhost:3000/api/process-captions`

---

### 2. Install the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `meet-scribe-extension/extension` directory.
5. The **MeetScribe Urdu** extension icon (🎙️) will appear in your Chrome toolbar.

---

### 3. Configure Settings

1. Click the MeetScribe icon in your toolbar, then click the **Settings (⚙️)** button.
2. Confirm the **Backend Server URL** is set to `http://localhost:3000`.
3. Enter your **Google Gemini API Key** from [Google AI Studio](https://aistudio.google.com/app/apikey).
4. Click **Save Settings**. The status badge in the header will display **Server Ready** (🟢).

---

## 🎙️ How to Use with Google Meet

1. Join any meeting on **[meet.google.com](https://meet.google.com)**.
2. Click the **MeetScribe Urdu** extension icon.
3. Click **"Start Meeting Recording"**.
   - Google Meet Closed Captions (CC) are automatically turned ON.
   - Dual-channel audio (tab + microphone) is recorded in the background with speaker passthrough so everyone remains audible.
4. Speak normally in Urdu, English, or mixed Urdish.
5. When finished, click **"Stop & Process Notes"**.
6. MeetScribe will:
   - **Immediately download `0_meeting_audio.webm` to your `Downloads` folder** (Audio is kept 100% private and never uploaded to any cloud server).
   - Extract the authentic speaker-tagged captions from Google Meet.
   - Send the captions text to the Express backend for Gemini structuring and translation.
   - Automatically save 4 organized UTF-8 text files to the meeting folder:
     ```text
     Downloads/MeetScribe_Urdu/Meeting_YYYY-MM-DD_HH-MM/
     ├── 0_meeting_audio.webm              # Full local audio recording
     ├── 1_transcript_urdu.txt             # Verified speaker Urdu transcript (UTF-8 BOM)
     ├── 2_transcript_english.txt          # Verified speaker English translation
     ├── 3_action_items_urdu.txt           # Urdu action items with assigned owners
     └── 4_action_items_english_improved.txt # Business English action items
     ```

---

## ⚙️ Key Technical Highlights

- **100% Ground-Truth Speaker Attribution**: By extracting Google Meet's WebRTC-stamped Closed Captions, attendee names (e.g. `Shoaib Shah`, `Abhishek Kamyani`) are authentic and never hallucinated by AI models.
- **Local Audio Privacy**: The full `.webm` Opus audio is saved directly to your computer *before* AI processing. Zero audio bytes are sent over the network.
- **Express Backend with Auth Scaffolding**: Provides clean separation of concerns, secure API key handling, and ready-to-use auth scaffolding (`/api/auth`) for future Google/Email user sign-in.
- **Anti-Arabic Urdu Guardrails**: Strict prompt engineering ensures natural Pakistani/Indian corporate vocabulary (`ہیلو`, `السلام علیکم`, `اپ ڈیٹ`, `بٹن`, `پیج`, `ٹیسٹ`).
