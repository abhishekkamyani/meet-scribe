# MeetScribe Urdu — Production Deployment & Distribution Guide

This guide explains how to deploy the **MeetScribe Urdu** backend to the cloud and package/distribute the **Chrome Extension** to your users.

---

## Architecture Overview

```
[ User's Browser (Chrome Extension) ] ─── HTTPS ───► [ Cloud Backend (Render / Railway) ]
        │                                                     │
        │                                                     ├──► Google Gemini Multimodal AI
        │                                                     └──► Groq Whisper Cloud
        ▼
[ Auto-downloads 5 files to User's PC ]
```

---

## Step 1: Deploy the Node.js Express Backend

To let anyone use your extension from anywhere, the backend API must be hosted with a public HTTPS URL.

### Recommended Platform: **Render.com** (Free & Fast)

1. Go to **[Render.com](https://render.com/)** and sign up / log in with your GitHub account.
2. Click **New +** &rarr; **Web Service**.
3. Select your GitHub repository (`MeetScribe Urdu`).
4. Configure the service settings:
   - **Name**: `meet-scribe-urdu-api`
   - **Region**: Closest to your users (e.g. Frankfurt, Singapore, Oregon)
   - **Root Directory**: `meet-scribe-extension/backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. **Environment Variables**:
   - `PORT`: `10000` (Render sets this automatically)
   - *(Optional server fallback keys)*:
     - `GROQ_API_KEY`: `your_groq_key`
     - `GEMINI_API_KEY`: `your_gemini_key`
6. Click **Deploy Web Service**.
7. Once deployed, Render will give you a public HTTPS URL:
   `https://meet-scribe-urdu-api.onrender.com`

---

## Step 2: Point Extension to Your Production Backend

Once you have your cloud URL (e.g., `https://meet-scribe-urdu-api.onrender.com`):

### 1. Update `manifest.json` Host Permissions
In [`meet-scribe-extension/extension/manifest.json`](file:///home/abhishek/Desktop/Work/MeetScribe%20Urdu/meet-scribe-extension/extension/manifest.json), add your deployed URL to `host_permissions`:

```json
  "host_permissions": [
    "https://meet.google.com/*",
    "https://meet-scribe-urdu-api.onrender.com/*",
    "http://localhost:*/*",
    "http://127.0.0.1:*/*"
  ]
```

### 2. Set Default Backend URL in `popup.js` & `offscreen.js`
In [`popup.js`](file:///home/abhishek/Desktop/Work/MeetScribe%20Urdu/meet-scribe-extension/extension/popup.js) and [`offscreen.js`](file:///home/abhishek/Desktop/Work/MeetScribe%20Urdu/meet-scribe-extension/extension/offscreen.js), update `defaultBackendUrl`:

```javascript
let defaultBackendUrl = 'https://meet-scribe-urdu-api.onrender.com';
```

*(Note: Users can still change or customize this URL anytime in the extension's ⚙️ Settings drawer).*

---

## Step 3: Package & Distribute the Extension to Users

You can distribute the extension to users via **Direct ZIP Sharing** (immediate) or the official **Chrome Web Store** (global).

---

### Option A: Direct Distribution (ZIP File for Teams & Friends)

This is the fastest method to share with colleagues or beta testers:

1. Create a clean ZIP archive of the `extension` folder:
   ```bash
   cd "meet-scribe-extension"
   zip -r meet-scribe-urdu-v1.0.0.zip extension/
   ```
2. Send `meet-scribe-urdu-v1.0.0.zip` to your users.
3. **User Installation Instructions**:
   - Download and extract `meet-scribe-urdu-v1.0.0.zip`.
   - Open Google Chrome and go to `chrome://extensions/`.
   - Enable **Developer mode** (toggle in top-right corner).
   - Click **"Load unpacked"** and select the unzipped `extension` folder.
   - Click the extension icon &rarr; ⚙️ Settings &rarr; add their free Gemini/Groq key &rarr; Done!

---

### Option B: Publish to the Official Chrome Web Store

Publishing to the Chrome Web Store allows anyone with Chrome to install your extension with a single click.

1. **Register as a Developer**:
   - Go to the **[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)**.
   - Pay the one-time $5 Google developer registration fee.
2. **Create the Upload ZIP**:
   ```bash
   cd "meet-scribe-extension/extension"
   zip -r ../meet-scribe-urdu-webstore.zip ./*
   ```
3. **Upload Item**:
   - Click **"Add new item"** on the dashboard and upload `meet-scribe-urdu-webstore.zip`.
4. **Store Listing Details**:
   - **Title**: `MeetScribe Urdu — Google Meet AI Transcriber`
   - **Summary**: `Transcribes Urdu, English, and bilingual Google Meet conversations and generates structured notes.`
   - **Category**: `Productivity` / `Workflow`
   - **Icons**: (Already in `icons/` folder: `16x16`, `48x48`, `128x128`).
   - **Screenshots**: Take 2–3 screenshots of the popup and the notes output.
5. **Privacy Tab**:
   - Declare single purpose: *"Transcribing and summarizing Google Meet conversations."*
   - Permission Justifications:
     - `tabCapture`: *"Captures meeting audio for transcription."*
     - `offscreen`: *"Processes Web Audio streams in the background."*
     - `storage`: *"Stores user configuration and API keys locally."*
     - `downloads`: *"Saves meeting notes and audio recordings to user's computer."*
6. **Submit for Review**:
   - Click **Submit for Review**.
   - Review typically takes **24–48 hours**, after which your extension will be live on the Chrome Web Store with a public installation link!
