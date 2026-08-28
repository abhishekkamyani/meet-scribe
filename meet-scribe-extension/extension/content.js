/**
 * MeetScribe Urdu - Google Meet Content Script
 * 1. Monitors Google Meet microphone mute/unmute state in real-time.
 * 2. Auto-enables Google Meet Closed Captions (CC) and maintains a persistent Keep-Alive Guardian.
 * 3. Scrapes 100% ground-truth real-time speaker-attributed captions from Google Meet DOM.
 * 4. Stealth Captions Shield: Keeps WebRTC captions stream alive even if user hides subtitles on screen.
 * 5. Extracts verified meeting participants roster.
 */

let lastMuteState = null;
let debounceTimeout = null;
let pollInterval = null;
let domObserver = null;
let captionsObserver = null;
let captionsKeepAliveInterval = null;
let isCapturingCaptions = false;
let isStealthMode = false;
let lastCaptionsToggleTime = 0; // Cooldown: prevent keep-alive from re-triggering too soon after a CC click

// Captions Storage: Array of { speaker: string, text: string, timestamp: string }
let captionsHistory = [];
let lastRecordedSpeaker = '';
let lastRecordedText = '';
const uniqueSpeakersSet = new Set();

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
  if (captionsObserver) {
    try { captionsObserver.disconnect(); } catch (e) {}
    captionsObserver = null;
  }
  if (captionsKeepAliveInterval) {
    clearInterval(captionsKeepAliveInterval);
    captionsKeepAliveInterval = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
    debounceTimeout = null;
  }
  removeStealthStyle();
}

/**
 * Inject or remove stealth CSS that allows captions to run in the background
 * without obstructing the user's video tiles or screen share.
 */
function injectStealthStyle() {
  if (document.getElementById('meetscribe-stealth-style')) return;
  const style = document.createElement('style');
  style.id = 'meetscribe-stealth-style';
  style.textContent = `
    /*
     * Stealth mode: captions are captured in the background but hidden from view.
     * IMPORTANT: Do NOT use height:1px or overflow:hidden — these break innerText scraping
     * because text outside the visible area is excluded from innerText.
     * Use off-screen positioning + opacity:0 instead: invisible but fully DOM-readable.
     */
    .meetscribe-stealth-active div[jsname="YSxPtf"],
    .meetscribe-stealth-active div.bh44bd,
    .meetscribe-stealth-active div.T4LgNb,
    .meetscribe-stealth-active div.a4cQT,
    .meetscribe-stealth-active [role="region"][aria-label*="caption" i] {
      opacity: 0 !important;
      position: fixed !important;
      left: -9999px !important;
      top: -9999px !important;
      pointer-events: none !important;
      z-index: -9999 !important;
      /* width/height intentionally NOT restricted — innerText needs normal element dimensions */
    }
  `;
  document.head.appendChild(style);
  document.body.classList.add('meetscribe-stealth-active');
}

function removeStealthStyle() {
  const style = document.getElementById('meetscribe-stealth-style');
  if (style) style.remove();
  document.body.classList.remove('meetscribe-stealth-active');
}

/**
 * Check if Google Meet Closed Captions are currently active
 */
function isMeetCaptionsActive() {
  const allButtons = document.querySelectorAll('button, div[role="button"]');
  for (const btn of allButtons) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
    const jsname = btn.getAttribute('jsname') || '';

    const isCcBtn =
      label.includes('caption') ||
      label.includes('subtitles') ||
      label.includes('سب ٹائٹل') ||
      label.includes('کیپشن') ||
      tooltip.includes('caption') ||
      tooltip.includes('subtitles') ||
      tooltip.includes('turn on captions') ||
      tooltip.includes('turn off captions') ||
      jsname === 'r8qRAd';

    if (isCcBtn) {
      const isPressed = btn.getAttribute('aria-pressed') === 'true' ||
        label.includes('turn off') ||
        tooltip.includes('turn off');
      return isPressed;
    }
  }

  // Also check for caption container in DOM — but do NOT require text content.
  // Captions go blank between utterances, causing false "CC is off" detection.
  const captionDom = document.querySelector([
    'div[jsname="YSxPtf"]',
    'div.bh44bd',
    'div.T4LgNb',
    '[role="region"][aria-label*="caption" i]',
    '[aria-live][aria-atomic="false"]'
  ].join(', '));
  // Container exists in DOM = CC is on (Google Meet removes it entirely when CC is off)
  return Boolean(captionDom);
}

/**
 * Silently enable CC using the keyboard shortcut 'c'.
 * Dispatching the 'c' key directly toggles captions ON/OFF without opening the settings modal.
 * Clicking the toolbar button opens the modal — keyboard shortcut does not.
 */
function silentlyToggleCaptionsOn() {
  // Only toggle if CC is currently OFF
  if (isMeetCaptionsActive()) return;

  console.log('[MeetScribe] Silently re-enabling CC via keyboard shortcut...');
  lastCaptionsToggleTime = Date.now();

  // Dispatch 'c' key to document — Meet's global shortcut handler will catch it
  ['keydown', 'keyup'].forEach(type => {
    document.dispatchEvent(new KeyboardEvent(type, {
      key: 'c', code: 'KeyC', keyCode: 67,
      bubbles: true, cancelable: true
    }));
  });

  // Also try on body in case Meet's handler is there
  ['keydown', 'keyup'].forEach(type => {
    document.body.dispatchEvent(new KeyboardEvent(type, {
      key: 'c', code: 'KeyC', keyCode: 67,
      bubbles: true, cancelable: true
    }));
  });

  // After a brief pause, check if CC came back on
  setTimeout(() => {
    if (isMeetCaptionsActive()) {
      console.log('[MeetScribe] CC re-enabled via keyboard shortcut ✓');
      // Re-apply stealth so the newly visible container is hidden again
      injectStealthStyle();
    } else {
      // Keyboard shortcut didn't work — try button click as last resort
      console.log('[MeetScribe] Keyboard shortcut did not enable CC, falling back to button click...');
      ensureCaptionsEnabled();
    }
  }, 800);
}

/**
 * Automatically ensure Google Meet Closed Captions (CC) are enabled.
 * Uses keyboard shortcut 'c' as primary (no modal), button click as fallback.
 */
function ensureCaptionsEnabled() {
  try {
    // Primary: keyboard shortcut 'c' directly toggles CC without opening any modal
    // Only do this if CC is actually OFF (don't toggle off something that's on)
    if (!isMeetCaptionsActive()) {
      console.log('[MeetScribe] Enabling CC via keyboard shortcut “c”...');
      lastCaptionsToggleTime = Date.now();
      ['keydown', 'keyup'].forEach(type => {
        document.dispatchEvent(new KeyboardEvent(type, {
          key: 'c', code: 'KeyC', keyCode: 67,
          bubbles: true, cancelable: true
        }));
      });

      // Verify after 1s; if keyboard didn't work, fall back to button click
      setTimeout(() => {
        if (!isMeetCaptionsActive()) {
          console.log('[MeetScribe] Keyboard shortcut did not work, trying CC button click...');
          const allButtons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of allButtons) {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
            const jsname = btn.getAttribute('jsname') || '';
            const isCcBtn =
              label.includes('caption') || label.includes('subtitles') ||
              label.includes('سب ٹائٹل') || label.includes('کیپشن') ||
              tooltip.includes('caption') || tooltip.includes('subtitles') ||
              jsname === 'r8qRAd';
            if (isCcBtn) {
              const isPressed = btn.getAttribute('aria-pressed') === 'true' ||
                label.includes('turn off') || tooltip.includes('turn off');
              if (!isPressed) {
                lastCaptionsToggleTime = Date.now();
                btn.click();
              }
              return;
            }
          }
        }
      }, 1000);
    } else {
      console.log('[MeetScribe] Google Meet CC is already ON.');
    }
    return true;
  } catch (err) {
    console.warn('[MeetScribe] Error ensuring captions enabled:', err);
    return false;
  }
}

/**
 * Captions Keep-Alive Guardian: Automatically re-enables captions if closed by user/Meet
 */
function maintainCaptionsKeepAlive() {
  if (!isCapturingCaptions) return;

  // Cooldown between re-enable attempts
  if (Date.now() - lastCaptionsToggleTime < 3000) return;

  if (!isMeetCaptionsActive()) {
    // CC is off — re-enable silently via keyboard shortcut (no modal)
    // This fires whether the user turned it off intentionally or Meet closed it.
    // The stealth CSS keeps it invisible so the user doesn’t see captions on screen.
    console.log('[MeetScribe] CC closed while recording — silently re-enabling in background...');
    silentlyToggleCaptionsOn();
  }
}

/**
 * Real-time Closed Captions Scraper & Accumulator
 * Uses a multi-layer detection strategy to survive Google Meet DOM changes:
 * Layer 1: Known jsname/class selectors (most specific, can go stale)
 * Layer 2: Semantic ARIA attributes (stable across Meet versions)
 * Layer 3: Broad aria-live sweep (last resort, catches anything)
 */
function findCaptionContainer() {
  // Layer 1: Known selectors
  const knownSelectors = [
    'div[jsname="YSxPtf"]',
    'div.bh44bd',
    'div.T4LgNb',
    'div.a4cQT',
  ];
  for (const sel of knownSelectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // Layer 2: Semantic ARIA — stable across Meet UI updates
  const ariaSelectors = [
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtitle" i]',
    '[role="region"][aria-label*="کیپشن" i]',
    '[aria-live="polite"][aria-atomic="false"]',
  ];
  for (const sel of ariaSelectors) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || '').trim().length > 1) return el;
  }

  // Layer 3: Any aria-live region in the lower half of the screen with text
  const liveRegions = document.querySelectorAll('[aria-live]');
  for (const el of liveRegions) {
    const text = (el.innerText || '').trim();
    if (text.length < 2) continue;
    const rect = el.getBoundingClientRect();
    // Captions appear in lower 50% of screen
    if (rect.top > window.innerHeight * 0.4 || rect.bottom > window.innerHeight * 0.5) {
      return el;
    }
  }

  return null;
}

function processCaptionsDOM() {
  try {
    const container = findCaptionContainer();
    if (!container) return;

    // Get individual caption blocks (speaker + text pairs)
    // Try specific child selectors first, fall back to container itself
    const childSelectors = [
      'div[jsname="YSxPtf"] > div',
      'div.bh44bd > div',
      'div.T4LgNb > div',
      'div.iTTPOb',
      'div.nMx0df',
      '[role="region"][aria-label*="caption" i] > div',
      '[aria-live][aria-atomic="false"] > div',
    ];

    let captionBlocks = document.querySelectorAll(childSelectors.join(', '));

    // If no child blocks, treat the container itself as the single block
    if (captionBlocks.length === 0) {
      captionBlocks = [container];
    }

    captionBlocks.forEach(block => {
      // 1. Extract Speaker Name
      let speakerName = '';

      const speakerEl = block.querySelector('.zs75Ib, .NW0r5c, .jxFHg, span.notranslate, div.notranslate, [data-self-name]');
      if (speakerEl) {
        speakerName = (speakerEl.innerText || speakerEl.getAttribute('data-self-name') || '').trim();
      }

      if (!speakerName) {
        const imgEl = block.querySelector('img[alt]');
        if (imgEl && imgEl.getAttribute('alt')) {
          const alt = imgEl.getAttribute('alt').trim();
          if (alt && !['avatar', 'profile', 'photo'].includes(alt.toLowerCase())) {
            speakerName = alt;
          }
        }
      }

      if (!speakerName) {
        const parent = block.closest('div[jsname="YSxPtf"], div.bh44bd, div.T4LgNb, [role="region"]');
        if (parent) {
          const prevHeader = parent.querySelector('.zs75Ib, .NW0r5c, .jxFHg');
          if (prevHeader) speakerName = prevHeader.innerText.trim();
        }
      }

      speakerName = speakerName
        .replace(/\s*\((?:You|آپ|Presentation|Host|Meeting host|Guest)\)/ig, '')
        .split('\n')[0]
        .trim();

      if (!speakerName && discoveredSelfName) {
        speakerName = discoveredSelfName;
      } else if (!speakerName && lastRecordedSpeaker) {
        speakerName = lastRecordedSpeaker;
      } else if (!speakerName) {
        speakerName = 'Participant';
      }

      // 2. Extract Spoken Text
      // Try specific span selectors first, then fall back to full innerText
      const textEls = block.querySelectorAll('span.VbkSUe, span.iTTPOb, div.T4LgNb, .yg3Swb, span[jsname="VbkSUe"]');
      let textContent = '';

      if (textEls.length > 0) {
        textContent = Array.from(textEls).map(el => el.innerText || '').join(' ').trim();
      }

      // Fallback: clone block, strip speaker element, get all innerText
      if (!textContent) {
        const clone = block.cloneNode(true);
        const rmSpeaker = clone.querySelector('.zs75Ib, .NW0r5c, .jxFHg, img');
        if (rmSpeaker) rmSpeaker.remove();
        textContent = (clone.innerText || '').trim();
      }

      // Last resort: use the raw innerText from the block as-is
      if (!textContent) {
        textContent = (block.innerText || '').trim();
      }

      if (!textContent || textContent.length < 1) return;

      uniqueSpeakersSet.add(speakerName);

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

      // 3. Deduplicate and merge streaming text
      if (captionsHistory.length > 0) {
        const lastEntry = captionsHistory[captionsHistory.length - 1];

        if (lastEntry.speaker === speakerName) {
          if (textContent.startsWith(lastEntry.text) || lastEntry.text.startsWith(textContent)) {
            if (textContent.length > lastEntry.text.length) {
              lastEntry.text = textContent;
              lastEntry.timestamp = timeStr;
            }
            return;
          }

          if (!lastEntry.text.endsWith(textContent) && !textContent.includes(lastEntry.text)) {
            lastEntry.text = `${lastEntry.text} ${textContent}`.replace(/\s+/g, ' ').trim();
            lastEntry.timestamp = timeStr;
            return;
          }
        }
      }

      // New distinct utterance block
      if (lastRecordedText !== textContent || lastRecordedSpeaker !== speakerName) {
        lastRecordedSpeaker = speakerName;
        lastRecordedText = textContent;

        captionsHistory.push({
          speaker: speakerName,
          text: textContent,
          timestamp: timeStr
        });

        console.log(`[MeetScribe Captions] [${timeStr}] [${speakerName}]: ${textContent}`);
      }
    });

  } catch (err) {
    console.warn('[MeetScribe] Error processing captions DOM:', err);
  }
}

/**
 * Start observing the captions container in Google Meet DOM with Keep-Alive Guardian
 */
function startCaptionsObserver() {
  if (captionsObserver) {
    try { captionsObserver.disconnect(); } catch (e) {}
    captionsObserver = null;
  }
  if (captionsKeepAliveInterval) {
    clearInterval(captionsKeepAliveInterval);
    captionsKeepAliveInterval = null;
  }

  isCapturingCaptions = true;
  injectStealthStyle();  // Also applies meetscribe-stealth-active class to body
  ensureCaptionsEnabled();

  // Warn if CC still not active 4 seconds after start (user may need to enable it)
  setTimeout(() => {
    if (isCapturingCaptions && !isMeetCaptionsActive()) {
      console.warn('[MeetScribe] WARNING: Google Meet captions do not appear to be active 4s into recording.');
      safeSendMessage({ type: 'CAPTIONS_NOT_DETECTED' });
    } else if (isCapturingCaptions) {
      console.log('[MeetScribe] Captions confirmed active and being captured.');
    }
  }, 4000);

  // Keep-alive guardian runs every 3s to re-enable CC if Meet closes it unexpectedly
  // (interval is intentionally not too aggressive to avoid fighting with user interactions)
  captionsKeepAliveInterval = setInterval(maintainCaptionsKeepAlive, 3000);

  captionsObserver = new MutationObserver(() => {
    if (isCapturingCaptions) {
      processCaptionsDOM();
      // C7 fix: do NOT call maintainCaptionsKeepAlive() here — on active Meet pages the observer
      // fires hundreds of times per second, completely defeating the 3s cooldown timer.
      // Keep-alive runs only on the timed interval (every 3s) set above.
    }
  });

  captionsObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  console.log('[MeetScribe Content] Real-time Captions Observer & Keep-Alive Guardian active.');
}

/**
 * Stop observing captions and return accumulated transcript
 */
function stopCaptionsObserver() {
  isCapturingCaptions = false;
  if (captionsKeepAliveInterval) {
    clearInterval(captionsKeepAliveInterval);
    captionsKeepAliveInterval = null;
  }
  if (captionsObserver) {
    try { captionsObserver.disconnect(); } catch (e) {}
    captionsObserver = null;
  }
  removeStealthStyle();

  processCaptionsDOM();
  return getFormattedCaptions();
}

/**
 * Format accumulated captions into a clean dialogue transcript
 */
function getFormattedCaptions() {
  const mergedUtterances = [];

  for (const entry of captionsHistory) {
    if (!entry.text || entry.text.trim().length === 0) continue;

    if (mergedUtterances.length > 0) {
      const prev = mergedUtterances[mergedUtterances.length - 1];
      if (prev.speaker === entry.speaker) {
        prev.text = `${prev.text} ${entry.text}`.replace(/\s+/g, ' ').trim();
        prev.timestamp = entry.timestamp;
        continue;
      }
    }

    mergedUtterances.push({
      speaker: entry.speaker,
      text: entry.text.trim(),
      timestamp: entry.timestamp
    });
  }

  const rawTranscript = mergedUtterances
    .map(u => `[${u.speaker}]: ${u.text}`)
    .join('\n');

  const participants = Array.from(new Set([
    ...Array.from(uniqueSpeakersSet),
    ...extractParticipantNames().allParticipants
  ])).filter(Boolean);

  return {
    rawTranscript: rawTranscript,
    utterances: mergedUtterances,
    participants: participants
  };
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

// Persistent participant discovery state
let discoveredSelfName = '';
const discoveredRemoteParticipants = new Set();

// Extract active participant names from Google Meet DOM
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
    'speaker view', 'presentation', 'your presentation', 'gemini', 'meet', 'google meet'
  ]);

  const participantSelectors = [
    'div[data-requested-participant-id] [title]',
    'div[data-participant-id] [title]',
    'div[data-participant-id]',
    'div[data-self-name]',
    'div[data-participant-name]',
    'div[role="listitem"] span[title]',
    'div[role="listitem"] [data-participant-id]',
    'span[jsname="WQtWae"]',
    'div[jsname="xySENc"]'
  ];

  const candidateElements = document.querySelectorAll(participantSelectors.join(', '));
  candidateElements.forEach(el => {
    let title = (el.getAttribute('title') || el.getAttribute('data-participant-name') || el.innerText || '').split('\n')[0].trim();
    title = title.replace(/\s*\((?:You|آپ|Presentation|Host|Meeting host|Guest|External)\)/ig, '').trim();

    if (
      title &&
      title.length >= 2 &&
      title.length <= 40 &&
      !title.includes('http') &&
      !title.includes(':') &&
      !ignoredLabels.has(title.toLowerCase())
    ) {
      roomParticipants.add(title);
      discoveredRemoteParticipants.add(title);
    }
  });

  const allFoundNames = Array.from(roomParticipants);
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

  domObserver = new MutationObserver(() => {
    triggerStateCheck();
    extractParticipantNames();
  });

  domObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-is-muted', 'aria-label', 'data-tooltip', 'class', 'title', 'data-participant-id', 'style'],
    subtree: true,
    childList: true
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      setTimeout(triggerStateCheck, 20);
    }
    // If user presses 'c' to toggle CC while recording, let keep-alive manage it
    if ((e.key === 'c' || e.key === 'C') && isCapturingCaptions && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
      setTimeout(maintainCaptionsKeepAlive, 50);
    }
  });

  window.addEventListener('click', (e) => {
    setTimeout(triggerStateCheck, 20);
    // Note: we intentionally do NOT call maintainCaptionsKeepAlive on every click,
    // as that caused the settings modal to reopen whenever the user closed it.
  });

  pollInterval = setInterval(() => {
    if (!isContextValid()) {
      cleanUpScript();
      return;
    }
    triggerStateCheck();
    extractParticipantNames();
  }, 200);

  notifyMicStateChange();
  extractParticipantNames();
}


// Re-injection guard: background.js may inject this script programmatically to ensure the
// latest version is running on existing Meet tabs (tabs opened before the extension was loaded/reloaded).
// This block prevents double message listeners, double observers, and double poll intervals.
if (window.__meetScribeContentLoaded) {
  console.log('[MeetScribe] Re-injected into already-active tab \u2014 cleaning up previous instance and reinitializing...');
  cleanUpScript();
  isCapturingCaptions = false;
  captionsHistory = [];
  lastRecordedSpeaker = '';
  lastRecordedText = '';
}
window.__meetScribeContentLoaded = true;

// Listen for messages from background / popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isContextValid()) return false;

  if (message.type === 'START_CAPTIONS_CAPTURE') {
    captionsHistory = [];
    uniqueSpeakersSet.clear();
    lastRecordedSpeaker = '';
    lastRecordedText = '';
    startCaptionsObserver();
    sendResponse({ success: true });
    return true;

  } else if (message.type === 'STOP_CAPTIONS_CAPTURE' || message.type === 'GET_CAPTIONS_TRANSCRIPT') {
    const data = stopCaptionsObserver();
    sendResponse({ success: true, ...data });
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

