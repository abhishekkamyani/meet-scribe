/**
 * MeetScribe Urdu - Popup Controller
 * Manages UI state transitions, live timer, Google Meet validation, and output previews.
 */

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
  backendUrlInput: document.getElementById('backend-url-input'),
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
let defaultBackendUrl = 'https://meet-scribe-five.vercel.app';
let userGroqKey = '';
let userGeminiKey = '';

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
      // Open dedicated full-tab permission page (prevents popup cut-off/closing!)
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    }
    return false;
  }
}

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Load saved settings & API keys (Auto-migrates from localhost to live production Vercel)
  const savedData = await chrome.storage.local.get(['backendUrl', 'groqApiKey', 'geminiApiKey']);
  
  let activeUrl = savedData.backendUrl;
  if (!activeUrl || activeUrl.includes('localhost') || activeUrl.includes('127.0.0.1')) {
    activeUrl = 'https://meet-scribe-five.vercel.app';
    await chrome.storage.local.set({ backendUrl: activeUrl });
  }

  defaultBackendUrl = activeUrl;
  userGroqKey = savedData.groqApiKey || '';
  userGeminiKey = savedData.geminiApiKey || '';

  elements.backendUrlInput.value = defaultBackendUrl;
  if (userGroqKey) elements.groqApiKeyInput.value = userGroqKey;
  if (userGeminiKey) elements.geminiApiKeyInput.value = userGeminiKey;

  // Show onboarding prompt if keys are missing
  checkMissingKeys(userGroqKey, userGeminiKey);

  // Check microphone access
  await ensureMicrophonePermission(false);

  // 2. Check active tab
  await checkActiveTab();

  // 3. Check backend health
  checkBackendHealth(defaultBackendUrl);

  // 4. Restore state
  await restoreState();

  // 5. Setup event listeners
  setupEventListeners();
});

// Check if API keys are configured
function checkMissingKeys(groqKey, geminiKey) {
  if (!groqKey || !geminiKey) {
    elements.missingKeysAlert.classList.remove('hidden');
  } else {
    elements.missingKeysAlert.classList.add('hidden');
  }
}

// Check if current tab is a Google Meet call
async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('meet.google.com')) {
      elements.activeTabTitle.textContent = tab.title || 'Google Meet';
      elements.notMeetAlert.classList.add('hidden');
      elements.meetDetectedBadge.textContent = 'Meet Ready';
      elements.meetDetectedBadge.className = 'pill-badge';
      elements.startRecordingBtn.disabled = false;
    } else {
      elements.activeTabTitle.textContent = tab ? (tab.title || 'Non-Meet Tab') : 'No tab detected';
      elements.notMeetAlert.classList.remove('hidden');
      elements.meetDetectedBadge.textContent = 'Not Meet';
      elements.meetDetectedBadge.className = 'pill-badge';
      elements.meetDetectedBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      elements.meetDetectedBadge.style.color = '#fcd34d';
      elements.meetDetectedBadge.style.background = 'rgba(245, 158, 11, 0.15)';
    }
  } catch (err) {
    console.error('Error querying active tab:', err);
  }
}

// Check if Express backend is running and keys are configured
async function checkBackendHealth(url) {
  const cleanGivenUrl = (url || 'https://meet-scribe-five.vercel.app').trim().replace(/\/+$/, '');
  const portsToTry = [cleanGivenUrl];
  if (!cleanGivenUrl.includes('vercel.app')) {
    if (!cleanGivenUrl.includes(':3001')) portsToTry.push('http://localhost:3001');
    if (!cleanGivenUrl.includes(':3000')) portsToTry.push('http://localhost:3000');
  }

  for (const testUrl of portsToTry) {
    try {
      const cleanTest = testUrl.trim().replace(/\/+$/, '');
      const res = await fetch(`${cleanTest}/api/health`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        
        // If detected on a fallback port, update active URL
        if (cleanTest !== cleanGivenUrl) {
          defaultBackendUrl = cleanTest;
          elements.backendUrlInput.value = cleanTest;
          await chrome.storage.local.set({ backendUrl: cleanTest });
        }

        // Keys are valid if either backend has .env configured OR user entered them in popup
        const storageKeys = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey']);
        const hasGroq = Boolean(data.config?.groqConfigured || userGroqKey || storageKeys.groqApiKey);
        const hasGemini = Boolean(data.config?.geminiConfigured || userGeminiKey || storageKeys.geminiApiKey);

        if (!hasGroq || !hasGemini) {
          elements.statusDot.className = 'status-dot warning';
          elements.statusText.textContent = 'Keys Missing';
          elements.missingKeysAlert.classList.remove('hidden');
        } else {
          elements.statusDot.className = 'status-dot online';
          elements.statusText.textContent = 'Online';
          elements.missingKeysAlert.classList.add('hidden');
        }
        return;
      }
    } catch (err) {
      // Continue to next port candidate
    }
  }

  // If all failed:
  elements.statusDot.className = 'status-dot offline';
  elements.statusText.textContent = 'Offline';
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
    elements.errorMessageText.textContent = data.lastError || 'An error occurred during meeting recording or transcription.';
  } else {
    showView('idle');
  }
}

// Timer logic
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

  // Reset tab button styles
  const allBtns = [elements.tabBtnUrTrans, elements.tabBtnEnTrans, elements.tabBtnUrAct, elements.tabBtnEnAct];
  allBtns.forEach(btn => {
    btn.className = 'tab-btn';
  });

  // Hide all content containers
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

  if (chrome.downloads && chrome.downloads.download) {
    try {
      await chrome.downloads.download({
        url: blobUrl,
        filename: fullPath,
        saveAs: false
      });
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
      elements.groqApiKeyInput.focus();
    });
  }

  // Mic Permission Alert Click
  if (elements.micPermissionAlert) {
    elements.micPermissionAlert.addEventListener('click', async () => {
      await ensureMicrophonePermission(true);
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

  // Save settings (including API keys)
  elements.saveSettingsBtn.addEventListener('click', async () => {
    const url = elements.backendUrlInput.value.trim() || 'http://localhost:3000';
    const groqKey = elements.groqApiKeyInput.value.trim();
    const geminiKey = elements.geminiApiKeyInput.value.trim();

    await chrome.storage.local.set({
      backendUrl: url,
      groqApiKey: groqKey,
      geminiApiKey: geminiKey
    });

    defaultBackendUrl = url;
    userGroqKey = groqKey;
    userGeminiKey = geminiKey;

    checkMissingKeys(groqKey, geminiKey);

    // Show temporary saved indicator
    if (elements.settingsSavedIndicator) {
      elements.settingsSavedIndicator.classList.remove('hidden');
      setTimeout(() => {
        elements.settingsSavedIndicator.classList.add('hidden');
      }, 2500);
    }

    setTimeout(() => {
      elements.settingsPanel.classList.add('hidden');
    }, 800);

    checkBackendHealth(url);
  });

  // Start Recording
  elements.startRecordingBtn.addEventListener('click', async () => {
    // 1. Ensure microphone permission is granted in extension context
    const micGranted = await ensureMicrophonePermission(true);
    if (!micGranted) {
      return;
    }

    // 2. Check if keys are set
    const data = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey']);
    const groqKey = data.groqApiKey || userGroqKey;
    const geminiKey = data.geminiApiKey || userGeminiKey;

    if (!groqKey || !geminiKey) {
      elements.settingsPanel.classList.remove('hidden');
      if (!groqKey) elements.groqApiKeyInput.focus();
      else elements.geminiApiKeyInput.focus();
      alert('Please enter your Groq and Gemini API keys in Settings before recording.');
      return;
    }

    elements.startRecordingBtn.disabled = true;
    showView('recording');
    startTimer(Date.now());

    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      backendUrl: defaultBackendUrl,
      groqApiKey: groqKey,
      geminiApiKey: geminiKey
    }, (response) => {
      elements.startRecordingBtn.disabled = false;
      if (response && !response.success) {
        stopTimer();
        showView('error');
        elements.errorMessageText.textContent = response.error || 'Failed to start recording.';
      }
    });
  });

  // Stop Recording
  elements.stopRecordingBtn.addEventListener('click', () => {
    stopTimer();
    showView('processing');
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
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
      setTimeout(() => {
        elements.copyBtnText.textContent = 'Copy';
      }, 2000);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  });

  // Re-download All Files into a dedicated folder
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

// Listen for storage changes in background/offscreen
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
