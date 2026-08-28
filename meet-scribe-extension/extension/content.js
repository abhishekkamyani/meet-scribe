/**
 * MeetScribe Urdu - Google Meet Content Script
 * 1. Monitors Google Meet microphone mute/unmute state in real-time.
 * 2. Passively discovers authenticated meeting participant roster without touching the UI.
 * 3. Zero visual interference: No captions toggled, no overlays, no layout modifications.
 */

let lastMuteState = null;
let debounceTimeout = null;
let pollInterval = null;
let domObserver = null;
let discoveredSelfName = '';
const discoveredParticipantsSet = new Set();

// Helper: Safely verify if extension context is valid
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && Boolean(chrome.runtime.id);
}

// Safely send message without throwing "Extension context invalidated"
function safeSendMessage(message) {
  if (!isContextValid()) {
    cleanUpScript();
    return;
  }

  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Ignored if receiver is busy or closed
      }
    });
  } catch (err) {
    cleanUpScript();
  }
}

// Clean up listeners if extension is reloaded/uninstalled
function cleanUpScript() {
  if (domObserver) {
    try { domObserver.disconnect(); } catch (e) {}
    domObserver = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
    debounceTimeout = null;
  }
  removeLegacyStyles();
}

/**
 * Clean up any injected legacy styles
 */
function removeLegacyStyles() {
  ['meetscribe-captions-overlay-style', 'meetscribe-hide-captions-style', 'meetscribe-stealth-style'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  document.body.classList.remove('meetscribe-hide-captions', 'meetscribe-stealth-active');
}

/**
 * Determine if the local user is currently muted in Google Meet.
 */
function getMeetMicStatus() {
  const allButtons = document.querySelectorAll('button, div[role="button"]');
  for (const btn of allButtons) {
    const isMutedAttr = btn.getAttribute('data-is-muted');
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();

    const isMicButton =
      label.includes('microphone') ||
      label.includes('mic') ||
      label.includes('مائیک') ||
      label.includes('مائیکروفون') ||
      tooltip.includes('microphone') ||
      tooltip.includes('mic') ||
      tooltip.includes('ctrl + d') ||
      tooltip.includes('ctrl+d') ||
      tooltip.includes('cmd + d') ||
      tooltip.includes('cmd+d') ||
      label.includes('ctrl + d') ||
      label.includes('ctrl+d');

    if (isMicButton) {
      if (isMutedAttr === 'true') return true;
      if (isMutedAttr === 'false') return false;

      if (
        label.includes('turn on') ||
        label.includes('unmute') ||
        label.includes('is off') ||
        label.includes('is muted') ||
        label.includes('مائیک آن') ||
        tooltip.includes('turn on') ||
        tooltip.includes('unmute')
      ) {
        return true;
      }

      if (
        label.includes('turn off') ||
        label.includes('is on') ||
        label.includes('mute') ||
        label.includes('مائیک بند') ||
        tooltip.includes('turn off') ||
        tooltip.includes('is on')
      ) {
        return false;
      }

      try {
        const bg = window.getComputedStyle(btn).backgroundColor;
        if (bg.includes('234, 67, 53') || bg.includes('217, 48, 37') || bg.includes('239, 68, 68') || bg.includes('220, 38, 38')) {
          return true;
        }
      } catch (e) {}
    }
  }

  const selfTileMuted = document.querySelectorAll(
    '[data-self-name] [data-is-muted="true"], [aria-label*="(You)"] [data-is-muted="true"], [aria-label*="(آپ)"] [data-is-muted="true"]'
  );
  if (selfTileMuted.length > 0) return true;

  const anyMuted = document.querySelector('button[data-is-muted="true"], div[data-is-muted="true"]');
  if (anyMuted) {
    const isControl = anyMuted.closest('div[role="region"], nav, footer, div[jscontroller], div[data-meeting-title]');
    if (isControl || anyMuted.tagName.toLowerCase() === 'button') {
      return true;
    }
  }

  return false;
}

// Broadcast current mute state if changed
function notifyMicStateChange() {
  if (!isContextValid()) {
    cleanUpScript();
    return;
  }

  const currentMuteState = getMeetMicStatus();
  if (currentMuteState !== lastMuteState) {
    lastMuteState = currentMuteState;
    console.log(`[MeetScribe Content] Local mic state: ${currentMuteState ? 'MUTED' : 'UNMUTED'}`);
    
    safeSendMessage({
      type: 'MEET_MIC_STATUS_CHANGED',
      isMuted: currentMuteState
    });
  }
}

function triggerStateCheck() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    notifyMicStateChange();
  }, 30);
}

/**
 * Comprehensive Participant Discovery:
 * Scans Google Meet participant tiles, sidebars, and aria tags to identify all attendees.
 */
function extractParticipantNames() {
  let selfName = '';
  const roomParticipants = new Set();

  const selfElement = document.querySelector('[data-self-name]');
  if (selfElement) {
    const name = (selfElement.getAttribute('data-self-name') || '').trim();
    if (name && name.length >= 2 && name.length <= 40 && !['You', 'آپ'].includes(name)) {
      selfName = name;
      discoveredSelfName = name;
    }
  }

  if (!selfName) {
    const youElements = document.querySelectorAll(
      '[aria-label*="(You)"], [aria-label*="(آپ)"], [title*="(You)"], [title*="(آپ)"], [aria-label*="Your presentation"]'
    );
    for (const el of youElements) {
      const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '';
      const match = raw.match(/^(.*?)\s*\((?:You|آپ|Presentation|Your presentation)\)/i);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name && name.length >= 2 && name.length <= 40 && !['You', 'آپ'].includes(name)) {
          selfName = name;
          discoveredSelfName = name;
          break;
        }
      }
    }
  }

  const ignoredLabels = new Set([
    'you', 'آپ', 'chat', 'people', 'host controls', 'activities', 'meeting details',
    'turn on microphone', 'turn off microphone', 'turn on camera', 'turn off camera',
    'raise hand', 'more options', 'leave call', 'info', 'show everyone', 'participants',
    'send a message to everyone', 'call details', 'pin', 'mute', 'unmute', 'grid view',
    'speaker view', 'presentation', 'your presentation', 'gemini', 'meet', 'google meet',
    'third', 'second', 'first', 'okay', 'yes', 'no'
  ]);

  const participantSelectors = [
    'div[data-requested-participant-id] [title]',
    'div[data-participant-id] [title]',
    'div[data-participant-id]',
    'div[data-self-name]',
    'div[data-participant-name]',
    'div[role="listitem"] span[title]',
    'div[role="listitem"] [data-participant-id]',
    'span.XE8e1d',
    'div.XE8e1d',
    'span.notranslate',
    'div.notranslate',
    'div[data-call-participant-id]',
    'span[jsname="WQtWae"]',
    'div[jsname="xySENc"]'
  ];

  const candidateElements = document.querySelectorAll(participantSelectors.join(', '));
  candidateElements.forEach(el => {
    let title = (el.getAttribute('title') || el.getAttribute('data-participant-name') || el.getAttribute('aria-label') || el.innerText || '').split('\n')[0].trim();
    title = title.replace(/\s*\((?:You|آپ|Presentation|Host|Meeting host|Guest|External)\)/ig, '').trim();

    if (
      title &&
      title.length >= 2 &&
      title.length <= 40 &&
      !title.includes('http') &&
      !title.includes(':') &&
      !title.includes('(') &&
      !ignoredLabels.has(title.toLowerCase())
    ) {
      roomParticipants.add(title);
      discoveredParticipantsSet.add(title);
    }
  });

  const allFoundNames = Array.from(new Set([...Array.from(discoveredParticipantsSet), ...Array.from(roomParticipants)]));
  let remoteArray = allFoundNames.filter(n => n !== selfName);

  if (!selfName && allFoundNames.length >= 2) {
    selfName = allFoundNames[0];
    remoteArray = allFoundNames.slice(1);
    discoveredSelfName = selfName;
  } else if (!selfName && discoveredSelfName) {
    selfName = discoveredSelfName;
    remoteArray = allFoundNames.filter(n => n !== selfName);
  }

  return {
    selfName: selfName || '',
    remoteParticipants: remoteArray,
    allParticipants: Array.from(new Set([selfName, ...allFoundNames])).filter(Boolean)
  };
}

// Initialize MutationObserver
function initObserver() {
  if (!isContextValid()) return;
  removeLegacyStyles();

  domObserver = new MutationObserver(() => {
    triggerStateCheck();
    extractParticipantNames();
  });

  domObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-is-muted', 'aria-label', 'data-tooltip', 'class', 'title', 'data-participant-id'],
    subtree: true,
    childList: true
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      setTimeout(triggerStateCheck, 20);
    }
  });

  window.addEventListener('click', (e) => {
    setTimeout(triggerStateCheck, 20);
  });

  pollInterval = setInterval(() => {
    if (!isContextValid()) {
      cleanUpScript();
      return;
    }
    triggerStateCheck();
    extractParticipantNames();
  }, 300);

  notifyMicStateChange();
  extractParticipantNames();
}

// Re-injection guard
if (window.__meetScribeContentLoaded) {
  cleanUpScript();
}
window.__meetScribeContentLoaded = true;

// Listen for messages from background / popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isContextValid()) return false;

  if (message.type === 'START_CAPTIONS_CAPTURE') {
    discoveredParticipantsSet.clear();
    extractParticipantNames();
    sendResponse({ success: true });
    return true;

  } else if (message.type === 'STOP_CAPTIONS_CAPTURE' || message.type === 'GET_CAPTIONS_TRANSCRIPT') {
    const participantsData = extractParticipantNames();
    sendResponse({
      success: true,
      rawTranscript: '',
      utterances: [],
      participants: participantsData.allParticipants
    });
    return true;

  } else if (message.type === 'GET_MEET_MIC_STATUS') {
    const isMuted = getMeetMicStatus();
    lastMuteState = isMuted;
    sendResponse({ isMuted });
    return true;

  } else if (message.type === 'GET_MEET_PARTICIPANTS') {
    const participantsData = extractParticipantNames();
    sendResponse({ participants: participantsData });
    return true;
  }
});

// Start monitoring when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initObserver);
} else {
  initObserver();
}
