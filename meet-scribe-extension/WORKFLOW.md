# MeetScribe Urdu — Architecture & End-to-End Workflow

This document details the complete end-to-end operational lifecycle, communication protocols, 100% ground-truth closed captions extraction, local audio recording preservation, and Express.js backend architecture of **MeetScribe Urdu**.

---

## 1. High-Level Architecture Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User as User (Google Meet Call)
    participant Popup as Extension Popup (popup.js)
    participant PermTab as Permission Tab (permission.html)
    participant SW as Background Service Worker (background.js)
    participant Content as Google Meet DOM & Captions (content.js)
    participant Offscreen as Offscreen Audio Recorder (offscreen.js)
    participant AudioOut as Local Speakers (AudioContext Passthrough)
    participant Backend as Express Backend (server.js)
    participant Gemini as Google Gemini AI (gemini-2.5/3.5/3.7-flash)
    participant Disk as User Downloads Folder

    %% Step 1: Start Recording
    User->>Popup: Clicks "Start Meeting Recording"
    alt First Time (Mic Not Yet Granted)
        Popup->>PermTab: Opens dedicated permission.html tab
        User->>PermTab: Clicks "Allow" on Chrome mic prompt
        PermTab-->>Popup: Permanently grants mic access & auto-closes
    end

    Popup->>SW: Sends `START_RECORDING`
    SW->>Content: Sends `START_CAPTIONS_CAPTURE`
    Content->>Content: Programmatically turns ON Google Meet Closed Captions ('c' / CC button)
    Content->>Content: Attaches real-time MutationObserver on caption stream
    
    SW->>SW: Acquires tab `streamId` via chrome.tabCapture
    SW->>Offscreen: Relays `START_OFFSCREEN_RECORDING` (streamId)
    SW->>Popup: Updates UI state: 'recording' + Sets red 'REC' badge

    %% Step 2: Live Meeting Phase
    Offscreen->>Offscreen: Captures Tab Audio (chromeMediaSourceId)
    Offscreen->>Offscreen: Captures User Microphone (getUserMedia)
    Offscreen->>AudioOut: Routes Tab Audio -> Speakers (Prevents Muted Tab!)
    Offscreen->>Offscreen: Merges Tab + Mic (+20% Gain) in AudioContext
    Offscreen->>Offscreen: MediaRecorder encodes 64kbps Opus WebM chunks locally

    loop While Meeting is Active
        Content->>Content: Collects real-time WebRTC speaker-tagged captions from DOM
        Content->>Content: Deduplicates stream & merges continuous speaker sentences
    end

    %% Step 3: Stop & Immediate Audio Preservation
    User->>Popup: Clicks "Stop & Process Notes"
    Popup->>SW: Sends `STOP_RECORDING`
    SW->>Offscreen: Sends `STOP_OFFSCREEN_RECORDING`
    Offscreen->>Offscreen: Compiles `0_meeting_audio.webm`
    Offscreen->>Disk: Auto-downloads `0_meeting_audio.webm` (Audio stays 100% LOCAL!)
    Note over Disk: 0_meeting_audio.webm is saved to disk BEFORE any AI request!

    %% Step 4: AI Captions Processing via Express Backend
    SW->>Content: Sends `STOP_CAPTIONS_CAPTURE`
    Content-->>SW: Returns 100% speaker-attributed dialogue JSON
    SW->>Backend: POST `/api/process-captions` (Text payload only)
    Backend->>Gemini: Translates, structures dialogue & extracts action items
    Gemini-->>Backend: Returns formatted bilingual JSON
    Backend-->>SW: Sends structured response

    %% Step 5: Organized Folder Downloads & UI
    SW->>Disk: Auto-downloads 4 structured text files to meeting folder
    Note over Disk: MeetScribe_Urdu/Meeting_[timestamp]/<br/>├── 0_meeting_audio.webm (Saved locally)<br/>├── 1_transcript_urdu.txt (UTF-8 BOM)<br/>├── 2_transcript_english.txt<br/>├── 3_action_items_urdu.txt<br/>└── 4_action_items_english_improved.txt

    SW->>SW: Persists results in chrome.storage.local & Sets 'DONE' badge
    SW->>Popup: Renders Complete View (Bilingual Tabs & Copy Buttons)
```

---

## 2. Step-by-Step Lifecycle Breakdown

### Phase 1: Initiation & Google Meet CC Auto-Enable
1. **Google Meet Validation**: [`popup.js`](file:///home/abhishek/Desktop/Work/MeetScribe%20Urdu/meet-scribe-extension/extension/popup.js) validates that the active tab is `meet.google.com`.
2. **Auto-Enabling Captions**: When recording starts, [`content.js`](file:///home/abhishek/Desktop/Work/MeetScribe%20Urdu/meet-scribe-extension/extension/content.js) automatically enables Closed Captions (CC) in Google Meet by clicking the CC button or dispatching the `c` shortcut.
3. **DOM MutationObserver**: Real-time caption mutations are observed, capturing the exact Google Meet profile name (e.g., `Shoaib Shah`, `Abhishek Kamyani`) and streaming text.

---

### Phase 2: Dual-Channel Audio Mixing & Instant Local Preservation
1. **Dual Capture**: [`offscreen.js`](file:///home/abhishek/Desktop/Work/MeetScribe%20Urdu/meet-scribe-extension/extension/offscreen.js) captures Google Meet tab audio + user microphone.
2. **Audio Passthrough**: Tab audio is connected to `audioContext.destination` to ensure you hear all participants clearly.
3. **Instant Local Download**: When recording stops, `0_meeting_audio.webm` is downloaded immediately to `Downloads/MeetScribe_Urdu/Meeting_[timestamp]/` **before** any AI or backend request is sent.
4. **Zero Audio Upload**: Audio files are never transmitted over the network, ensuring 100% privacy and zero upload latency.

---

### Phase 3: Express Backend & Google Gemini AI Processing
1. **Payload**: Ground-truth speaker-tagged caption text is sent to the Express.js backend at `/api/process-captions`.
2. **Google Gemini Structuring**: Gemini formats the dialogue, provides high-fidelity Urdu and English translations, and extracts concrete action items assigned directly to the verified speaker names.
3. **Linguistic Guardrails**: Explicit anti-Arabic prompting ensures authentic Pakistani/Indian corporate Urdu vocabulary (`ہیلو`, `السلام علیکم`, `اپ ڈیٹ`, `بٹن`, `پیج`).

---

### Phase 4: Download Organization & Popup Display
1. The extension downloads 4 structured UTF-8 text files alongside the local audio file:
   - `0_meeting_audio.webm` (Local audio recording)
   - `1_transcript_urdu.txt` (Urdu transcript in UTF-8 BOM)
   - `2_transcript_english.txt` (English translation)
   - `3_action_items_urdu.txt` (Urdu action items)
   - `4_action_items_english_improved.txt` (Executive English action items)
2. Results are rendered in the popup with 4 interactive tabs and one-click clipboard copying.
