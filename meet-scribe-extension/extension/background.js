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

        // Send STOP message to offscreen document
        // Offscreen directly performs fetch to backend and initiates downloads!
        await chrome.runtime.sendMessage({
          type: 'STOP_OFFSCREEN_RECORDING'
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
