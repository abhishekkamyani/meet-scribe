/**
 * MeetScribe Urdu - Dedicated Microphone Permission Handler
 * Runs in a full tab so Chrome's permission prompt doesn't close the extension popup.
 */

async function requestMicrophone() {
  const btn = document.getElementById('grant-mic-btn');
  const statusSuccess = document.getElementById('status-success');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Stop tracks immediately after permission is confirmed
    stream.getTracks().forEach(track => track.stop());

    btn.classList.add('hidden');
    statusSuccess.classList.remove('hidden');

    // Notify extension storage that mic permission is granted
    await chrome.storage.local.set({ micPermissionGranted: true });

    // Auto-close this tab after 1.2s
    setTimeout(() => {
      window.close();
    }, 1200);

  } catch (err) {
    console.error('Microphone permission request rejected:', err);
    btn.textContent = 'Retry Microphone Permission';
    alert('Please click "Allow" when Chrome prompts for microphone access in the top-left of the browser.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('grant-mic-btn');
  btn.addEventListener('click', requestMicrophone);
  
  // Also attempt trigger immediately on tab load
  requestMicrophone();
});
