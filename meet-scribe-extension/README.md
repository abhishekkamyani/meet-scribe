# MeetScribe Urdu (میٹ اسکرائب اردو)
### AI-Powered Google Meet Transcriber & Bilingual Meeting Notes Generator

MeetScribe Urdu is a Chrome Manifest V3 extension and Node.js Express backend that captures Google Meet tab audio, transcribes bilingual Urdu/English ("Urdish") speech using **Groq Whisper (`whisper-large-v3`)**, structures and translates meeting notes with **Google Gemini**, and automatically downloads 4 separate UTF-8 text files.

---

## 📁 Project Structure

```text
meet-scribe-extension/
├── extension/
│   ├── manifest.json       # Chrome Manifest V3 definition
│   ├── popup.html          # Tailwind CSS UI with Urdu Nastaliq typography
│   ├── popup.js            # UI state manager & Google Meet validator
│   ├── background.js       # Service worker: stream acquisition & offscreen lifecycle
│   ├── offscreen.html      # Offscreen audio recording container
│   ├── offscreen.js        # MediaRecorder with AudioContext passthrough & direct upload
│   └── icons/              # 16px, 48px, 128px extension icons
└── backend/
    ├── package.json        # Express, Multer, Groq SDK, Google Generative AI
    ├── server.js           # /api/process-meeting endpoint & AI orchestration
    ├── .env                # Local configuration
    └── .env.example        # Environment variable template
```

---

## 🚀 Quick Start Guide

### 1. Backend Setup

1. Open a terminal and navigate to the `backend` directory:
   ```bash
   cd meet-scribe-extension/backend
   npm install
   ```

2. Configure your API keys in `backend/.env`:
   ```env
   PORT=3000
   GROQ_API_KEY=your_groq_api_key_here
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
   * **Groq API Key**: Get free ultra-fast Whisper keys from [Groq Console](https://console.groq.com/keys).
   * **Gemini API Key**: Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

3. Start the Express server:
   ```bash
   npm start
   ```
   Verify the health endpoint at: `http://localhost:3000/api/health`

---

### 2. Chrome Extension Installation

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `meet-scribe-extension/extension` directory.
5. The **MeetScribe Urdu** extension icon (🎙️) will appear in your Chrome toolbar. Pin it for quick access.

---

## 🎙️ How to Use with Google Meet

1. Join or start any meeting on **[meet.google.com](https://meet.google.com)**.
2. Click the **MeetScribe Urdu** extension icon.
3. Click **"Start Meeting Recording"**.
   - Tab audio capture begins in an offscreen document.
   - **Audio Passthrough**: You can still hear meeting participants seamlessly without tab muting.
4. Conduct your meeting in Urdu, English, or Urdish.
5. When finished, click **"Stop & Process Notes"**.
6. MeetScribe will:
   - Encode the audio to `.webm` Opus.
   - Send it to Groq Whisper (`whisper-large-v3`, `language: 'ur'`).
   - Pass the transcript to Gemini to extract structured decisions and action items.
   - Automatically trigger 4 UTF-8 text file downloads to your `Downloads` folder:
     1. `1_transcript_urdu_[date].txt` (Full verbatim Urdu transcript)
     2. `2_transcript_english_[date].txt` (Accurate end-to-end English translation)
     3. `3_action_items_urdu_[date].txt` (Urdu bullet points)
     4. `4_action_items_english_improved_[date].txt` (Polished business English action items)
7. You can also view and copy each tab directly from the extension popup.

---

## ⚙️ Key Technical Implementations

- **Manifest V3 30-Second SW Timeout Bypass**: The offscreen document directly executes the `fetch()` upload and triggers the downloads, ensuring long meetings (e.g. 45+ minutes) complete reliably even when the service worker is idle.
- **Strict Offscreen Enums**: Uses `reasons: [chrome.offscreen.Reason.USER_MEDIA]` to strictly comply with Chrome's offscreen document specification.
- **Tab Muting Prevention (Audio Passthrough)**: Routes the `tabCapture` stream through `AudioContext.destination` before feeding it to `MediaRecorder`.
- **Nastaliq Unicode Encoding**: Files are generated with UTF-8 BOM (`\uFEFF`) and `text/plain;charset=utf-8` to ensure crisp rendering in all operating systems and editors without character corruption.
