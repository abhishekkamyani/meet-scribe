/**
 * MeetScribe Urdu - Background Service Worker (Manifest V3)
 * Manages offscreen document lifecycle, tab stream capture ID, and status state.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

// Helper: Ensure the offscreen document is open
async function ensureOffscreenDocument() {
  // Check if offscreen document already exists
  if ('hasDocument' in chrome.offscreen) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  } else {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    if (existingContexts.length > 0) return;
  }

  // Create offscreen document with STRICT enum
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Recording Google Meet tab audio for Urdu speech-to-text and AI transcription'
  });
}

// Handle messages from Popup or Offscreen Document
// Extract visible participant names from Google Meet tab DOM
async function extractGoogleMeetParticipants(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const names = new Set();
        
        // 1. Participant names from tiles, badges, and data attributes
        document.querySelectorAll('[data-self-name], [data-participant-id], .ZjFb7c, .XE8e1b, div[data-requested-participant-id]').forEach(el => {
          const raw = el.getAttribute('data-self-name') || el.innerText;
          if (raw && typeof raw === 'string') {
            const clean = raw.split('\n')[0].trim();
            if (clean.length >= 2 && clean.length <= 35 && !['You', 'Presenting', 'Microphone', 'Meeting details', 'Turn on captions'].includes(clean)) {
              names.add(clean);
            }
          }
        });

        // 2. Video tile name tags
        document.querySelectorAll('span.notranslate, div.notranslate').forEach(el => {
          const txt = el.innerText ? el.innerText.trim() : '';
          if (txt.length >= 2 && txt.length <= 30 && !txt.includes('\n') && !['Chat', 'People', 'Activities', 'Host controls', 'You', 'Meeting details'].includes(txt)) {
            names.add(txt);
          }
        });

        return Array.from(names);
      }
    });

    if (results && results[0] && Array.isArray(results[0].result)) {
      console.log('[Background] Extracted Google Meet participants:', results[0].result);
      return results[0].result;
    }
  } catch (err) {
    console.warn('[Background] Could not extract participants:', err);
  }
  return [];
}

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

        // Get active Google Meet tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !tab.url.includes('meet.google.com')) {
          await chrome.storage.local.set({ recordingState: 'idle' });
          sendResponse({
            success: false,
            error: 'Please navigate to an active Google Meet meeting tab (meet.google.com) before starting recording.'
          });
          return;
        }

        // 1. Get media stream ID for tabCapture
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        if (!streamId) {
          throw new Error('Failed to acquire tabCapture media stream ID.');
        }

        // 2. Ensure Offscreen document is loaded
        await ensureOffscreenDocument();

        // 3. Send START message to offscreen document with user API keys
        const backendUrl = message.backendUrl || 'http://localhost:3000';
        const storageData = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey']);
        const groqApiKey = message.groqApiKey || storageData.groqApiKey || '';
        const geminiApiKey = message.geminiApiKey || storageData.geminiApiKey || '';

        await chrome.runtime.sendMessage({
          type: 'START_OFFSCREEN_RECORDING',
          streamId: streamId,
          tabTitle: tab.title || 'Google Meet',
          backendUrl: backendUrl,
          groqApiKey: groqApiKey,
          geminiApiKey: geminiApiKey
        });

        // 4. Update UI State & Badge
        const startTime = Date.now();
        await chrome.storage.local.set({
          recordingState: 'recording',
          recordingStartTime: startTime,
          currentMeetingTitle: tab.title || 'Google Meet'
        });

        await chrome.action.setBadgeText({ text: 'REC' });
        await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });

        sendResponse({ success: true, startTime });

      } else if (message.type === 'STOP_RECORDING') {
        await chrome.storage.local.set({ recordingState: 'processing' });
        await chrome.action.setBadgeText({ text: 'AI...' });
        await chrome.action.setBadgeBackgroundColor({ color: '#3B82F6' });

        // Extract participant names from active Google Meet tab
        let participants = [];
        const [meetTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (meetTab && meetTab.id && meetTab.url && meetTab.url.includes('meet.google.com')) {
          participants = await extractGoogleMeetParticipants(meetTab.id);
        }

        // Send STOP message to offscreen document with participant list
        await chrome.runtime.sendMessage({
          type: 'STOP_OFFSCREEN_RECORDING',
          participants: participants
        });

        sendResponse({ success: true });

      } else if (message.type === 'EXECUTE_DOWNLOAD') {
        // Native folder-structured download
        const { filename, url } = message;
        if (url && filename) {
          await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false
          });
        }
        sendResponse({ success: true });

      } else if (message.type === 'OFFSCREEN_STATUS_UPDATE') {
        // Offscreen document updates state
        if (message.state === 'processing') {
          await chrome.storage.local.set({
            recordingState: 'processing',
            processingStep: message.step || 'Processing meeting audio...'
          });
        } else if (message.state === 'complete') {
          await chrome.storage.local.set({
            recordingState: 'complete',
            lastResults: message.data,
            completedAt: new Date().toISOString(),
            lastError: null
          });
          await chrome.action.setBadgeText({ text: 'DONE' });
          await chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
          // Clear badge after 10 seconds
          setTimeout(() => {
            chrome.action.setBadgeText({ text: '' });
          }, 10000);
        } else if (message.state === 'error') {
          await chrome.storage.local.set({
            recordingState: 'error',
            lastError: message.error || 'An error occurred during audio processing.'
          });
          await chrome.action.setBadgeText({ text: 'ERR' });
          await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
        }
        sendResponse({ received: true });
      }
    } catch (err) {
      console.error('[Background] Error processing message:', err);
      await chrome.storage.local.set({
        recordingState: 'error',
        lastError: err.message || 'An unexpected error occurred.'
      });
      await chrome.action.setBadgeText({ text: 'ERR' });
      await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});

// Clean up badge and state on extension install/update
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    recordingState: 'idle',
    backendUrl: 'http://localhost:3000'
  });
  await chrome.action.setBadgeText({ text: '' });
});
