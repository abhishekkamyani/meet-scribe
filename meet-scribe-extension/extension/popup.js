/**
 * MeetScribe Urdu - Popup Controller (100% Dynamic)
 * Auto-discovers backend endpoints, auto-detects participant names, and manages UI states.
 */

const CANDIDATE_BACKEND_URLS = [
  'http://localhost:3001',
  'http://localhost:3000',
  'https://meet-scribe-five.vercel.app'
];

// DOM Elements
const elements = {
  // Views
  viewIdle: document.getElementById('view-idle'),
  viewRecording: document.getElementById('view-recording'),
  viewProcessing: document.getElementById('view-processing'),
  viewComplete: document.getElementById('view-complete'),
  viewError: document.getElementById('view-error'),

  // Header & Status
  backendStatusBadge: document.getElementById('backend-status-badge'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  toggleSettingsBtn: document.getElementById('toggle-settings-btn'),
  settingsPanel: document.getElementById('settings-panel'),
  groqApiKeyInput: document.getElementById('groq-api-key-input'),
  geminiApiKeyInput: document.getElementById('gemini-api-key-input'),
  toggleGroqKeyBtn: document.getElementById('toggle-groq-key-btn'),
  toggleGeminiKeyBtn: document.getElementById('toggle-gemini-key-btn'),
  settingsSavedIndicator: document.getElementById('settings-saved-indicator'),
  missingKeysAlert: document.getElementById('missing-keys-alert'),
  micPermissionAlert: document.getElementById('mic-permission-alert'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  notMeetAlert: document.getElementById('not-meet-alert'),

  // Idle View
  activeTabTitle: document.getElementById('active-tab-title'),
  detectedParticipantsRow: document.getElementById('detected-participants-row'),
  detectedParticipantsText: document.getElementById('detected-participants-text'),
  meetDetectedBadge: document.getElementById('meet-detected-badge'),
  startRecordingBtn: document.getElementById('start-recording-btn'),

  // Recording View
  recordingTimer: document.getElementById('recording-timer'),
  stopRecordingBtn: document.getElementById('stop-recording-btn'),

  // Processing View
  processingStepLabel: document.getElementById('processing-step-label'),

  // Complete View
  downloadAllBtn: document.getElementById('download-all-btn'),
  copyTabContentBtn: document.getElementById('copy-tab-content-btn'),
  copyBtnText: document.getElementById('copy-btn-text'),
  newRecordingBtn: document.getElementById('new-recording-btn'),

  // Tabs
  tabBtnUrTrans: document.getElementById('tab-btn-ur-trans'),
  tabBtnEnTrans: document.getElementById('tab-btn-en-trans'),
  tabBtnUrAct: document.getElementById('tab-btn-ur-act'),
  tabBtnEnAct: document.getElementById('tab-btn-en-act'),

  tabContentUrTrans: document.getElementById('tab-content-ur-trans'),
  tabContentEnTrans: document.getElementById('tab-content-en-trans'),
  tabContentUrAct: document.getElementById('tab-content-ur-act'),
  tabContentEnAct: document.getElementById('tab-content-en-act'),

  // Error View
  errorMessageText: document.getElementById('error-message-text'),
  errorRetryBtn: document.getElementById('error-retry-btn')
};

let timerInterval = null;
let currentResults = null;
let activeTabType = 'ur-trans';
let userGroqKey = '';
let userGeminiKey = '';
let activeBackendUrl = 'http://localhost:3001';
let activeMeetTabId = null;

// Request / Verify Microphone Permission
async function ensureMicrophonePermission(interactive = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    if (elements.micPermissionAlert) elements.micPermissionAlert.classList.add('hidden');
    return true;
  } catch (err) {
    console.warn('Microphone permission check:', err.name, err.message);
    if (elements.micPermissionAlert) elements.micPermissionAlert.classList.remove('hidden');
    if (interactive) {
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    }
    return false;
  }
}

// Dynamically discover and test backend endpoints
async function autoDiscoverBackend() {
  const saved = await chrome.storage.local.get('backendUrl');
  const candidates = Array.from(new Set([
    saved.backendUrl,
    ...CANDIDATE_BACKEND_URLS
  ])).filter(Boolean);

  for (const url of candidates) {
    const cleanUrl = url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleanUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        activeBackendUrl = cleanUrl;
        await chrome.storage.local.set({ backendUrl: cleanUrl });
        elements.statusDot.className = 'status-dot online';
        elements.statusText.textContent = 'Server Online';
        return cleanUrl;
      }
    } catch (e) {
      // Try next candidate
    }
  }

  // If local server is not running
  elements.statusDot.className = 'status-dot warning';
  elements.statusText.textContent = 'Server Offline';
  return activeBackendUrl;
}

// Update API key alert banner
function updateAPIKeyStatus(groqKey, geminiKey) {
  if (geminiKey || groqKey) {
    if (elements.missingKeysAlert) elements.missingKeysAlert.classList.add('hidden');
  } else {
    if (elements.missingKeysAlert) elements.missingKeysAlert.classList.remove('hidden');
  }
}

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Load saved settings (API keys)
  const savedData = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey']);
  
  userGroqKey = savedData.groqApiKey || '';
  userGeminiKey = savedData.geminiApiKey || '';

  if (elements.groqApiKeyInput && userGroqKey) elements.groqApiKeyInput.value = userGroqKey;
  if (elements.geminiApiKeyInput && userGeminiKey) elements.geminiApiKeyInput.value = userGeminiKey;

  updateAPIKeyStatus(userGroqKey, userGeminiKey);

  // 2. Auto-discover backend dynamically
  autoDiscoverBackend();

  // 3. Check microphone access
  await ensureMicrophonePermission(false);

  // 4. Check active Google Meet tab & dynamically detect attendees
  await checkActiveTab();

  // 5. Restore state
  await restoreState();

  // 6. Setup event listeners
  setupEventListeners();
});

// Check if current tab is a Google Meet call and dynamically detect participants
async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('meet.google.com')) {
      activeMeetTabId = tab.id;
      elements.activeTabTitle.textContent = tab.title || 'Google Meet';
      elements.notMeetAlert.classList.add('hidden');
      elements.meetDetectedBadge.textContent = 'Meet Ready';
      elements.meetDetectedBadge.className = 'pill-badge';
      elements.startRecordingBtn.disabled = false;

      // Query content script for dynamic live participant discovery
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_MEET_PARTICIPANTS' }, (res) => {
          // M1 fix: check lastError to prevent "Unchecked runtime.lastError" console spam
          if (chrome.runtime.lastError) {
            // Content script not yet injected (tab still loading) — silently ignore
            return;
          }
          if (res && res.participants) {
            const { selfName, remoteParticipants, allParticipants } = res.participants;
            const namesList = [];

            if (selfName) {
              namesList.push(`${selfName} (You)`);
            }
            if (Array.isArray(remoteParticipants)) {
              remoteParticipants.forEach(p => {
                if (p && p !== selfName && !namesList.includes(p)) namesList.push(p);
              });
            } else if (Array.isArray(allParticipants)) {
              allParticipants.forEach(p => {
                if (p && p !== selfName && !namesList.includes(p)) namesList.push(p);
              });
            }

            if (namesList.length > 0 && elements.detectedParticipantsRow && elements.detectedParticipantsText) {
              elements.detectedParticipantsText.textContent = namesList.join(', ');
              elements.detectedParticipantsRow.classList.remove('hidden');
            }
          }
        });
      } catch (pErr) {
        console.warn('Could not query participants:', pErr);
      }

    } else {
      activeMeetTabId = null;
      elements.activeTabTitle.textContent = tab ? (tab.title || 'Non-Meet Tab') : 'No tab detected';
      elements.notMeetAlert.classList.remove('hidden');
      elements.meetDetectedBadge.textContent = 'Not Meet';
      elements.meetDetectedBadge.className = 'pill-badge';
      elements.meetDetectedBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      elements.meetDetectedBadge.style.color = '#fcd34d';
      elements.meetDetectedBadge.style.background = 'rgba(245, 158, 11, 0.15)';
      if (elements.detectedParticipantsRow) elements.detectedParticipantsRow.classList.add('hidden');
    }
  } catch (err) {
    console.error('Error querying active tab:', err);
  }
}

// Show a specific UI view
function showView(viewName) {
  elements.viewIdle.classList.add('hidden');
  elements.viewRecording.classList.add('hidden');
  elements.viewProcessing.classList.add('hidden');
  elements.viewComplete.classList.add('hidden');
  elements.viewError.classList.add('hidden');

  if (viewName === 'idle') elements.viewIdle.classList.remove('hidden');
  if (viewName === 'recording') elements.viewRecording.classList.remove('hidden');
  if (viewName === 'processing') elements.viewProcessing.classList.remove('hidden');
  if (viewName === 'complete') elements.viewComplete.classList.remove('hidden');
  if (viewName === 'error') elements.viewError.classList.remove('hidden');
}

// Restore saved state from chrome.storage
async function restoreState() {
  const data = await chrome.storage.local.get([
    'recordingState',
    'recordingStartTime',
    'lastResults',
    'lastError',
    'processingStep'
  ]);

  const state = data.recordingState || 'idle';

  if (state === 'recording') {
    showView('recording');
    startTimer(data.recordingStartTime || Date.now());
  } else if (state === 'processing') {
    showView('processing');
    if (data.processingStep) {
      elements.processingStepLabel.textContent = data.processingStep;
    }
  } else if (state === 'complete' && data.lastResults) {
    showView('complete');
    populateResults(data.lastResults);
  } else if (state === 'error') {
    showView('error');
    elements.errorMessageText.textContent = data.lastError || 'An error occurred during meeting processing.';
  } else {
    showView('idle');
  }
}

// Live timer
function startTimer(startTime) {
  if (timerInterval) clearInterval(timerInterval);

  function update() {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    elements.recordingTimer.textContent = `${mins}:${secs}`;
  }

  update();
  timerInterval = setInterval(update, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Populate complete view with results
function populateResults(data) {
  currentResults = data;
  elements.tabContentUrTrans.textContent = data.transcript_urdu || 'کوئی ٹرانسکرپٹ دستیاب نہیں ہے۔';
  elements.tabContentEnTrans.textContent = data.transcript_english || 'No English transcript available.';
  elements.tabContentUrAct.textContent = data.action_items_urdu || 'کوئی ایکشن آئٹم دستیاب نہیں ہے۔';
  elements.tabContentEnAct.textContent = data.action_items_english_improved || 'No action items available.';
  switchTab('ur-trans');
}

// Tab Switching
function switchTab(tab) {
  activeTabType = tab;

  const allBtns = [elements.tabBtnUrTrans, elements.tabBtnEnTrans, elements.tabBtnUrAct, elements.tabBtnEnAct];
  allBtns.forEach(btn => { btn.className = 'tab-btn'; });

  elements.tabContentUrTrans.classList.add('hidden');
  elements.tabContentEnTrans.classList.add('hidden');
  elements.tabContentUrAct.classList.add('hidden');
  elements.tabContentEnAct.classList.add('hidden');

  if (tab === 'ur-trans') {
    elements.tabBtnUrTrans.className = 'tab-btn active';
    elements.tabContentUrTrans.classList.remove('hidden');
  } else if (tab === 'en-trans') {
    elements.tabBtnEnTrans.className = 'tab-btn active';
    elements.tabContentEnTrans.classList.remove('hidden');
  } else if (tab === 'ur-act') {
    elements.tabBtnUrAct.className = 'tab-btn active';
    elements.tabContentUrAct.classList.remove('hidden');
  } else if (tab === 'en-act') {
    elements.tabBtnEnAct.className = 'tab-btn active';
    elements.tabContentEnAct.classList.remove('hidden');
  }
}

// Download Helper with Folder support
async function triggerDownload(folderName, filename, content) {
  const fullPath = folderName ? `${folderName}/${filename}` : filename;
  const utf8BOM = '\uFEFF';
  const blob = new Blob([utf8BOM + content], { type: 'text/plain;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  // M3 fix: always schedule revocation to prevent memory leak from accumulating blob URLs
  const revokeAfterDelay = () => setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);

  if (chrome.downloads && chrome.downloads.download) {
    try {
      await chrome.downloads.download({
        url: blobUrl,
        filename: fullPath,
        saveAs: false
      });
      revokeAfterDelay();
      return;
    } catch (e) {
      console.warn('chrome.downloads failed, using anchor tag fallback:', e);
    }
  }

  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fullPath;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  revokeAfterDelay();
}

// Setup Event Listeners
function setupEventListeners() {
  // Settings toggle
  elements.toggleSettingsBtn.addEventListener('click', () => {
    elements.settingsPanel.classList.toggle('hidden');
  });

  // Onboarding Alert Click
  if (elements.missingKeysAlert) {
    elements.missingKeysAlert.addEventListener('click', () => {
      elements.settingsPanel.classList.remove('hidden');
      elements.geminiApiKeyInput.focus();
    });
  }

  // Toggle Groq Key Visibility
  if (elements.toggleGroqKeyBtn) {
    elements.toggleGroqKeyBtn.addEventListener('click', () => {
      const isPass = elements.groqApiKeyInput.type === 'password';
      elements.groqApiKeyInput.type = isPass ? 'text' : 'password';
      elements.toggleGroqKeyBtn.textContent = isPass ? '🔒' : '👁️';
    });
  }

  // Toggle Gemini Key Visibility
  if (elements.toggleGeminiKeyBtn) {
    elements.toggleGeminiKeyBtn.addEventListener('click', () => {
      const isPass = elements.geminiApiKeyInput.type === 'password';
      elements.geminiApiKeyInput.type = isPass ? 'text' : 'password';
      elements.toggleGeminiKeyBtn.textContent = isPass ? '🔒' : '👁️';
    });
  }

  // Save API keys
  elements.saveSettingsBtn.addEventListener('click', async () => {
    const groqKey = elements.groqApiKeyInput.value.trim();
    const geminiKey = elements.geminiApiKeyInput.value.trim();

    await chrome.storage.local.set({
      groqApiKey: groqKey,
      geminiApiKey: geminiKey
    });

    userGroqKey = groqKey;
    userGeminiKey = geminiKey;
    updateAPIKeyStatus(groqKey, geminiKey);

    if (elements.settingsSavedIndicator) {
      elements.settingsSavedIndicator.classList.remove('hidden');
      setTimeout(() => {
        elements.settingsSavedIndicator.classList.add('hidden');
      }, 2000);
    }

    // N3 fix: close settings panel AFTER the saved indicator is done showing (2000ms)
    // Previously it closed at 800ms while the indicator was still visible at 2500ms
    setTimeout(() => {
      elements.settingsPanel.classList.add('hidden');
    }, 1800);
  });

  // Start Recording
  elements.startRecordingBtn.addEventListener('click', async () => {
    const micGranted = await ensureMicrophonePermission(true);
    if (!micGranted) return;

    // C4 fix: show a "Starting…" disabled state BEFORE we know if background succeeded.
    // Do NOT transition to recording view yet — wait for background confirmation.
    elements.startRecordingBtn.disabled = true;
    elements.startRecordingBtn.querySelector('span:last-child').textContent = 'Starting…';

    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: activeMeetTabId
    }, (response) => {
      elements.startRecordingBtn.disabled = false;
      elements.startRecordingBtn.querySelector('span:last-child').textContent = 'Start Meeting Recording';

      if (chrome.runtime.lastError || !response || !response.success) {
        const errMsg = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Failed to start recording.';
        showView('error');
        elements.errorMessageText.textContent = errMsg;
        return;
      }

      // Only now show recording view — we have confirmed background success
      showView('recording');
      startTimer(response.startTime || Date.now());
    });
  });

  // Stop Recording
  elements.stopRecordingBtn.addEventListener('click', () => {
    stopTimer();
    showView('processing');

    // C5 fix: STOP_RECORDING was fire-and-forget — if background threw an error during AI processing,
    // the popup would be stuck on the processing spinner forever.
    // Now we listen for the response and show the error view if processing fails.
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (response) => {
      if (chrome.runtime.lastError) {
        // Background service worker was terminated mid-flight (e.g. browser closed SW)
        // The storage onChanged listener will restore state when SW comes back up
        console.warn('[Popup] STOP_RECORDING response lost (SW terminated?):', chrome.runtime.lastError.message);
        return;
      }
      if (response && !response.success) {
        showView('error');
        elements.errorMessageText.textContent = response.error || 'Processing failed.';
      }
      // Success case is handled by chrome.storage.onChanged → restoreState()
    });
  });

  // Tabs
  elements.tabBtnUrTrans.addEventListener('click', () => switchTab('ur-trans'));
  elements.tabBtnEnTrans.addEventListener('click', () => switchTab('en-trans'));
  elements.tabBtnUrAct.addEventListener('click', () => switchTab('ur-act'));
  elements.tabBtnEnAct.addEventListener('click', () => switchTab('en-act'));

  // Copy to Clipboard
  elements.copyTabContentBtn.addEventListener('click', async () => {
    if (!currentResults) return;
    let textToCopy = '';
    if (activeTabType === 'ur-trans') textToCopy = currentResults.transcript_urdu || '';
    if (activeTabType === 'en-trans') textToCopy = currentResults.transcript_english || '';
    if (activeTabType === 'ur-act') textToCopy = currentResults.action_items_urdu || '';
    if (activeTabType === 'en-act') textToCopy = currentResults.action_items_english_improved || '';

    try {
      await navigator.clipboard.writeText(textToCopy);
      elements.copyBtnText.textContent = 'Copied!';
      setTimeout(() => { elements.copyBtnText.textContent = 'Copy'; }, 2000);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  });

  // Re-download All Files into folder
  elements.downloadAllBtn.addEventListener('click', async () => {
    if (!currentResults) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
    const folderName = `MeetScribe_Urdu/Meeting_${dateStr}_${timeStr}`;
    
    await triggerDownload(folderName, '1_transcript_urdu.txt', currentResults.transcript_urdu || '');
    await new Promise(r => setTimeout(r, 250));
    await triggerDownload(folderName, '2_transcript_english.txt', currentResults.transcript_english || '');
    await new Promise(r => setTimeout(r, 250));
    await triggerDownload(folderName, '3_action_items_urdu.txt', currentResults.action_items_urdu || '');
    await new Promise(r => setTimeout(r, 250));
    await triggerDownload(folderName, '4_action_items_english_improved.txt', currentResults.action_items_english_improved || '');
  });

  // Record Another Meeting
  elements.newRecordingBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      recordingState: 'idle',
      lastResults: null,
      lastError: null
    });
    showView('idle');
    await checkActiveTab();
  });

  // Retry / Dismiss Error
  elements.errorRetryBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ recordingState: 'idle', lastError: null });
    showView('idle');
    await checkActiveTab();
  });
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.recordingState) {
      restoreState();
    }
    if (changes.processingStep && elements.processingStepLabel) {
      elements.processingStepLabel.textContent = changes.processingStep.newValue || 'Processing...';
    }
  }
});

// Listen for direct messages from background (e.g. CC warnings during recording)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CAPTIONS_NOT_DETECTED') {
    // Show a warning in the recording view's timer subtext
    const timerSubtext = document.querySelector('.timer-subtext');
    if (timerSubtext) {
      timerSubtext.textContent = '⚠️ Captions not detected — please enable CC in Meet to get transcript';
      timerSubtext.style.color = '#fbbf24';
    }
  }
});
