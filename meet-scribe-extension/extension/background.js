/**
 * MeetScribe Urdu - Background Service Worker (Manifest V3)
 * Orchestrates:
 * 1. Google Meet real-time Closed Captions extraction via content script.
 * 2. High-Definition local audio recording (AEC + Noise Cancellation) with instant download.
 * 3. Dynamic Express backend discovery and communication (/api/process-captions).
 * 4. Automatic organized folder downloads and badge/state persistence.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const CANDIDATE_BACKEND_URLS = [
  'http://localhost:3001',
  'http://localhost:3000',
  'https://meet-scribe-five.vercel.app'
];

// Helper: Ensure the offscreen document is open
async function ensureOffscreenDocument() {
  if ('hasDocument' in chrome.offscreen) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  } else {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    if (existingContexts.length > 0) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Recording Google Meet audio for local meeting backup'
  });
}

// Download 4 structured text files to the meeting folder
async function downloadTextFilesToFolder(folderName, data) {
  const utf8BOM = 'data:text/plain;charset=utf-8,\uFEFF';
  const files = [
    { name: '1_transcript_urdu.txt', content: data.transcript_urdu || '' },
    { name: '2_transcript_english.txt', content: data.transcript_english || '' },
    { name: '3_action_items_urdu.txt', content: data.action_items_urdu || '' },
    { name: '4_action_items_english_improved.txt', content: data.action_items_english_improved || '' }
  ];

  for (const file of files) {
    const encodedUri = utf8BOM + encodeURIComponent(file.content);
    const fullPath = folderName ? `${folderName}/${file.name}` : file.name;

    try {
      await chrome.downloads.download({
        url: encodedUri,
        filename: fullPath,
        saveAs: false
      });
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.warn('[Background] Error downloading file:', file.name, e);
    }
  }
}

// Helper: Dynamically send captions to available backend candidate
async function postCaptionsToBackend(payload) {
  const storageData = await chrome.storage.local.get('backendUrl');
  const candidates = Array.from(new Set([
    storageData.backendUrl,
    ...CANDIDATE_BACKEND_URLS
  ])).filter(Boolean);

  let lastError = null;

  for (const url of candidates) {
    const cleanUrl = url.replace(/\/+$/, '');
    try {
      console.log(`[Background] Attempting backend connection at ${cleanUrl}/api/process-captions...`);
      const response = await fetch(`${cleanUrl}/api/process-captions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(payload.geminiApiKey ? { 'X-Gemini-API-Key': payload.geminiApiKey } : {}),
          ...(payload.groqApiKey ? { 'X-Groq-API-Key': payload.groqApiKey } : {})
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        const errText = await response.text();
        let parsedMsg = errText;
        try {
          const j = JSON.parse(errText);
          parsedMsg = j.error || j.message || errText;
        } catch (e) {}
        throw new Error(`Backend Error (${response.status}): ${parsedMsg}`);
      }

      const resJson = await response.json();
      if (!resJson.success || !resJson.data) {
        throw new Error(resJson.error || 'Invalid response from processing backend.');
      }

      // Save working backend URL
      await chrome.storage.local.set({ backendUrl: cleanUrl });
      return resJson.data;

    } catch (err) {
      console.warn(`[Background] Connection to ${cleanUrl} failed:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('Could not connect to backend server. Please ensure npm start is running in the backend folder.');
}

// Handle all extension messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'START_RECORDING') {
        const { recordingState = 'idle' } = await chrome.storage.local.get('recordingState');
        if (recordingState === 'recording' || recordingState === 'starting') {
          sendResponse({ success: false, error: 'Recording is already in progress.' });
          return;
        }

        await chrome.storage.local.set({ recordingState: 'starting' });

        // C1 fix: query by URL, not by active tab in current window — popup being open would
        // cause active:true/currentWindow:true to return the popup context instead of Meet.
        const meetTabs = await chrome.tabs.query({ url: '*://meet.google.com/*' });
        const tab = meetTabs[0];
        if (!tab || !tab.url || !tab.url.includes('meet.google.com')) {
          await chrome.storage.local.set({ recordingState: 'idle' });
          sendResponse({
            success: false,
            error: 'Please navigate to an active Google Meet tab (meet.google.com) before starting recording.'
          });
          return;
        }

        // 2. Inject content script programmatically to guarantee latest version is running.
        // Manifest content_scripts only inject at page-load time, so if Meet was already open
        // (before extension install or after a reload), content.js was never there.
        // chrome.scripting.executeScript fixes this — the guard in content.js handles re-injection safely.
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          console.log('[Background] content.js injected into Meet tab successfully.');
          // Brief pause to let the script initialize before we message it
          await new Promise(r => setTimeout(r, 400));
        } catch (injectErr) {
          console.warn('[Background] Could not inject content.js (may not have scripting permission or tab is restricted):', injectErr.message);
        }

        // 3. Start Captions capture in Google Meet tab (auto-enables CC and starts DOM observer)
        try {
          const captureRes = await chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTIONS_CAPTURE' });
          if (captureRes && captureRes.success) {
            console.log('[Background] START_CAPTIONS_CAPTURE confirmed by content script.');
          } else {
            console.warn('[Background] START_CAPTIONS_CAPTURE: unexpected response', captureRes);
          }
        } catch (captionsErr) {
          // Content script not yet injected (e.g. page still loading) — recording continues, captions optional
          console.warn('[Background] Could not initialize captions on tab (content script may not be ready):', captionsErr.message);
        }


        // 4. Acquire tab audio stream ID
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        if (!streamId) {
          throw new Error('Failed to acquire tabCapture stream ID.');
        }

        // 4. Ensure Offscreen document is active
        await ensureOffscreenDocument();

        // 5. Query initial mic status
        let initialMuteState = false;
        try {
          const micRes = await chrome.tabs.sendMessage(tab.id, { type: 'GET_MEET_MIC_STATUS' });
          if (micRes && typeof micRes.isMuted === 'boolean') {
            initialMuteState = micRes.isMuted;
          }
        } catch (e) {}

        // 6. Start Offscreen local audio recording (with AEC & Noise Cancellation)
        await chrome.runtime.sendMessage({
          type: 'START_OFFSCREEN_RECORDING',
          streamId: streamId,
          initialMuteState: initialMuteState
        });

        // 7. Update UI state & badge
        const startTime = Date.now();
        await chrome.storage.local.set({
          recordingState: 'recording',
          recordingStartTime: startTime,
          currentMeetingTitle: tab.title || 'Google Meet',
          activeTabId: tab.id
        });

        await chrome.action.setBadgeText({ text: 'REC' });
        await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });

        sendResponse({ success: true, startTime });

      } else if (message.type === 'MEET_MIC_STATUS_CHANGED') {
        chrome.runtime.sendMessage({
          type: 'UPDATE_MIC_MUTE_STATE',
          isMuted: message.isMuted
        }).catch(() => {});
        sendResponse({ received: true });

      } else if (message.type === 'CAPTIONS_NOT_DETECTED') {
        // Content script warns that CC is not active 4s into recording
        // Forward to popup so user sees an actionable warning
        await chrome.storage.local.set({
          processingStep: '⚠️ Google Meet Captions not detected. Please enable CC in Meet (button at the bottom of the screen).'
        });
        chrome.runtime.sendMessage({
          type: 'CAPTIONS_NOT_DETECTED'
        }).catch(() => {});
        sendResponse({ received: true });

      } else if (message.type === 'STOP_RECORDING') {
        await chrome.storage.local.set({
          recordingState: 'processing',
          processingStep: 'Stopping audio and saving local recording...'
        });
        await chrome.action.setBadgeText({ text: 'AI...' });
        await chrome.action.setBadgeBackgroundColor({ color: '#3B82F6' });

        // Step 1: Stop offscreen audio recorder and trigger INSTANT local 0_meeting_audio.webm download
        // C2 fix: wrap with a timeout so a crashed/missing offscreen document never hangs STOP_RECORDING forever
        let folderName = '';
        try {
          const offscreenRes = await Promise.race([
            chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_RECORDING' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Offscreen stop timed out after 15s')), 15000))
          ]);
          if (offscreenRes && offscreenRes.folderName) {
            folderName = offscreenRes.folderName;
          }
        } catch (audioStopErr) {
          console.warn('[Background] Error stopping offscreen recording:', audioStopErr);
        }

        if (!folderName) {
          const now = new Date();
          const dateStr = now.toISOString().slice(0, 10);
          const timeStr = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
          folderName = `MeetScribe_Urdu/Meeting_${dateStr}_${timeStr}`;
        }

        // Step 2: Retrieve ground-truth speaker captions from Google Meet content script
        await chrome.storage.local.set({
          processingStep: 'Extracting verified speaker captions from Google Meet...'
        });

        let captionsData = { rawTranscript: '', utterances: [], participants: [] };

        // IMPORTANT: Always use the stored activeTabId (saved when recording started).
        // Do NOT use chrome.tabs.query({ active: true, currentWindow: true }) as the primary source —
        // when the popup is open, that query returns the popup's window context, not the Meet tab.
        const { activeTabId: storedTabId } = await chrome.storage.local.get('activeTabId');
        let targetTabId = storedTabId;

        // Fallback: if stored ID is missing, search all tabs for an active Google Meet tab
        if (!targetTabId) {
          const meetTabs = await chrome.tabs.query({ url: '*://meet.google.com/*' });
          if (meetTabs.length > 0) {
            targetTabId = meetTabs[0].id;
            console.warn('[Background] activeTabId not in storage, falling back to Meet tab search:', targetTabId);
          }
        }

        if (targetTabId) {
          try {
            const capRes = await chrome.tabs.sendMessage(targetTabId, { type: 'STOP_CAPTIONS_CAPTURE' });
            if (capRes && capRes.success) {
              captionsData = capRes;
            }
          } catch (capErr) {
            console.warn('[Background] Could not retrieve captions from content script:', capErr.message);
          }
        } else {
          console.warn('[Background] Could not determine target Meet tab ID to retrieve captions.');
        }

        // Step 3: Process meeting content (Captions if available, Audio AI fallback if captions are empty)
        const storageData = await chrome.storage.local.get(['geminiApiKey', 'groqApiKey', 'backendUrl']);
        const geminiApiKey = storageData.geminiApiKey || '';
        const groqApiKey = storageData.groqApiKey || '';
        const activeUrl = storageData.backendUrl || 'http://localhost:3001';

        let structuredData = null;

        if (captionsData && captionsData.rawTranscript && captionsData.rawTranscript.trim().length > 10) {
          await chrome.storage.local.set({
            processingStep: 'Structuring bilingual Urdu/English notes with Gemini...'
          });
          console.log('[Background] Using live speaker captions for AI notes...');
          structuredData = await postCaptionsToBackend({
            transcript: captionsData.rawTranscript || '',
            utterances: captionsData.utterances || [],
            participants: captionsData.participants || [],
            geminiApiKey: geminiApiKey,
            groqApiKey: groqApiKey
          });
        } else {
          // No live captions captured — automatically transcribe crystal-clear audio recording with AI!
          await chrome.storage.local.set({
            processingStep: 'Transcribing meeting audio recording with AI...'
          });
          console.log('[Background] No captions in DOM, activating Audio AI transcription fallback...');

          try {
            const audioFallbackRes = await chrome.runtime.sendMessage({
              type: 'PROCESS_AUDIO_FALLBACK',
              backendUrl: activeUrl,
              geminiApiKey: geminiApiKey,
              groqApiKey: groqApiKey,
              participants: captionsData.participants || []
            });

            if (audioFallbackRes && audioFallbackRes.success && audioFallbackRes.data) {
              structuredData = audioFallbackRes.data;
              console.log('[Background] Audio AI fallback transcription successful ✓');
            } else {
              throw new Error((audioFallbackRes && audioFallbackRes.error) || 'Audio AI fallback returned no data');
            }
          } catch (audioErr) {
            console.warn('[Background] Audio AI fallback failed, posting captions payload as last resort:', audioErr.message);
            structuredData = await postCaptionsToBackend({
              transcript: captionsData.rawTranscript || '',
              utterances: captionsData.utterances || [],
              participants: captionsData.participants || [],
              geminiApiKey: geminiApiKey,
              groqApiKey: groqApiKey
            });
          }
        }

        // Step 4: Download the 4 UTF-8 text files to the same meeting folder
        await chrome.storage.local.set({
          processingStep: 'Saving 4 structured notes files to Downloads...'
        });

        await downloadTextFilesToFolder(folderName, structuredData);

        // Step 5: Mark complete and save data
        await chrome.storage.local.set({
          recordingState: 'complete',
          lastResults: structuredData,
          completedAt: new Date().toISOString(),
          lastError: null,
          activeTabId: null  // C3 fix: clear stored tab ID so a future recording on a different Meet tab starts fresh
        });

        await chrome.action.setBadgeText({ text: 'DONE' });
        await chrome.action.setBadgeBackgroundColor({ color: '#10B981' });

        setTimeout(() => {
          chrome.action.setBadgeText({ text: '' });
        }, 10000);

        sendResponse({ success: true, data: structuredData });

      } else if (message.type === 'EXECUTE_DOWNLOAD') {
        const { filename, url } = message;
        if (url && filename) {
          await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false
          });
        }
        sendResponse({ success: true });
      }
    } catch (err) {
      console.error('[Background] Error handling message:', err);
      await chrome.storage.local.set({
        recordingState: 'error',
        lastError: err.message || 'An unexpected error occurred.'
      });
      await chrome.action.setBadgeText({ text: 'ERR' });
      await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// Setup default config on install
chrome.runtime.onInstalled.addListener(async () => {
  // N2 fix: only set backendUrl default if user hasn't already saved a custom one
  const existing = await chrome.storage.local.get(['backendUrl', 'recordingState']);
  const updates = { recordingState: 'idle' };
  if (!existing.backendUrl) {
    updates.backendUrl = 'http://localhost:3001';
  }
  await chrome.storage.local.set(updates);
  await chrome.action.setBadgeText({ text: '' });
});
