# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MeetScribe Urdu** is a Chrome Manifest V3 extension + Express.js backend that captures Google Meet live captions and tab audio, then uses Google Gemini AI (with Groq Whisper as fallback) to generate bilingual Urdu/English meeting notes — strictly without speaker names.

# Claude Code Rules

## Token & Credit Management
- **Remember: Use less number of credits.**
- **Diffs only:** Never rewrite an entire file if you are only changing a few lines.
- **Strict tool efficiency:** Run the minimum number of terminal commands or file reads necessary to complete the task.


## Running the Backend

```bash
cd meet-scribe-extension/backend
npm install
npm start          # production (node server.js)
npm run dev        # development with auto-reload (node --watch server.js)
```

Backend starts on port `3001` by default (auto-increments if port is busy). The server discovers the next free port automatically up to 10 retries.

- Health check: `http://localhost:3001/api/health`
- Captions endpoint: `POST http://localhost:3001/api/process-captions`
- Audio endpoint: `POST http://localhost:3001/api/process-meeting`

## Environment Setup

Copy `.env.example` to `.env` in `meet-scribe-extension/backend/`:

```
PORT=3001
GEMINI_API_KEY=your_gemini_api_key_here   # Primary AI — required
GROQ_API_KEY=your_groq_api_key_here       # Optional fallback
GEMINI_MODEL=gemini-2.5-flash             # Optional model override
```

## Installing the Chrome Extension

1. Go to `chrome://extensions/` → enable **Developer mode**
2. Click **Load unpacked** → select `meet-scribe-extension/extension/`
3. Configure backend URL and Gemini API key via the popup Settings (⚙️)

Both API keys (Gemini + Groq) must be configured before starting a recording — the extension enforces this at startup.

## Architecture

### Two-Component System

```
meet-scribe-extension/
├── backend/          # Express.js Node server
│   ├── server.js     # All API routes + Gemini/Groq AI logic
│   └── vercel.json   # Serverless deployment config
└── extension/        # Chrome MV3 extension
    ├── manifest.json
    ├── background.js  # Service worker — pipeline coordinator
    ├── content.js     # Google Meet CC scraper (injected into meet.google.com)
    ├── offscreen.js   # Audio recorder (runs in offscreen document)
    ├── popup.js/html  # UI + settings
    └── permission.js  # Mic permission request handler
```

### Message Flow

1. **popup.js** validates active tab is `meet.google.com`, then sends `START_RECORDING` to **background.js**
2. **background.js** (service worker) acquires `streamId` via `chrome.tabCapture`, opens the offscreen document, and relays `START_OFFSCREEN_RECORDING`
3. **offscreen.js** captures tab audio + microphone simultaneously, mixes them with DSP (high-pass filter + compressor), and encodes as Opus WebM via `MediaRecorder`
4. On stop: offscreen downloads `0_meeting_audio.webm` immediately to disk, then sends audio to backend
5. **background.js** dynamically discovers the backend URL from `CANDIDATE_BACKEND_URLS` (`localhost:3001` → `localhost:3000` → Vercel fallback)
6. **server.js** processes audio: Gemini multimodal audio (primary) → Groq Whisper STT + Gemini text formatting (fallback)
7. Background downloads 4 organized UTF-8 text files into `Downloads/MeetScribe_Urdu/Meeting_[timestamp]/`

### Backend AI Pipeline (server.js)

- **Primary path (`/api/process-captions`)**: Receives caption text from the extension, formats it with Gemini (`gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-1.5-*` cascade)
- **Audio path (`/api/process-meeting`)**: Receives `.webm` audio via multipart upload; tries Gemini direct multimodal audio, falls back to Groq Whisper Large v3 STT then Gemini text formatting
- **`sanitizePlainMeetingNotes()`** post-processes all AI output to strip any speaker tags that leaked through
- API keys can be passed per-request via `X-Gemini-API-Key` / `X-Groq-API-Key` headers (extension sends user's keys from `chrome.storage.local`) or from server `.env`

### Extension Key Behaviors

- **content.js** scrapes Google Meet CC panels using strict DOM selectors — explicitly rejects notification toasts to avoid hardware names leaking in
- **background.js** auto-enables Google Meet CC when recording starts
- **offscreen.js** routes tab audio to `AudioContext.destination` so the user can still hear participants during recording
- Backend URL discovery is dynamic: tries stored URL first, then `CANDIDATE_BACKEND_URLS` in order

### Output Files per Meeting

```
Downloads/MeetScribe_Urdu/Meeting_YYYY-MM-DD_HH-MM/
├── 0_meeting_audio.webm
├── 1_transcript_urdu.txt          (UTF-8 BOM)
├── 2_transcript_english.txt       (UTF-8 BOM)
├── 3_action_items_urdu.txt        (UTF-8 BOM)
└── 4_action_items_english_improved.txt
```

## Key Constraints & Guardrails

- **No speaker names** in any output — `stripSpeakerTags()` in server.js enforces this via regex post-processing
- **Urdu language guardrails**: All Gemini prompts explicitly specify Pakistani/Indian Urdu (نستعلیق), not Arabic, with tech vocabulary examples to prevent mishearing (e.g., "UI" must not become "اوائی")
- **Whisper hallucination scrubbing**: Common silence hallucinations ("Thank you for watching", etc.) are stripped from Groq Whisper output
- **500MB audio upload limit** enforced by multer; temp files are always deleted after processing (`finally` block)
- The extension is Manifest V3 — `chrome.tabCapture` requires the call to originate from the active tab's context (handled via `activeTab` permission + strict tabId passing from popup)
