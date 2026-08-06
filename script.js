

// Global orchestrator to manage media playback and stop inactive players
const mediaStopRegistry = {};
let activeMediaId = null;

function registerMedia(id, stopFunction) {
  mediaStopRegistry[id] = stopFunction;
}

function stopAllMedia(exceptId) {
  if (activeMediaId && activeMediaId !== exceptId && mediaStopRegistry[activeMediaId]) {
    mediaStopRegistry[activeMediaId]();
  }
  activeMediaId = exceptId;
}

function setupHlsPlayerOverlay(videoId, overlayId, hlsUrl) {
  const video = document.getElementById(videoId);
  const overlay = document.getElementById(overlayId);
  let hlsLoaded = false;
  let hlsInstance = null;

  function showOverlay() {
    overlay.removeAttribute('hidden');
    video.pause();
    video.currentTime = 0;
    video.load();
  }
  function hideOverlay() {
    overlay.setAttribute('hidden', '');
  }

  function stopStream() {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    video.removeAttribute('src');
    video.load();
    hlsLoaded = false;
    showOverlay();
  }

  // Register this video player with the orchestrator
  registerMedia(videoId, stopStream);

  function startStream() {
    // Stop other active media before starting this one
    stopAllMedia(videoId);

    if (!hlsLoaded && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.loadSource(hlsUrl);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play();
      });
      hlsInstance.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          showOverlay();
          hlsInstance.destroy();
          hlsLoaded = false;
        }
      });
      hlsLoaded = true;
    } else if (!hlsLoaded && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', function () {
        video.play();
      });
      hlsLoaded = true;
    } else {
      video.src = hlsUrl;
      video.play();
    }
    hideOverlay();
  }

  overlay.addEventListener('click', startStream);
  video.addEventListener('play', hideOverlay);
  video.addEventListener('pause', function() {
    if (video.currentTime === 0 || video.ended) {
      showOverlay();
    }
  });

  // Show overlay on load
  showOverlay();
}

setupHlsPlayerOverlay('rtv-video', 'rtv-overlay', 'https://5c46fa289c89f.streamlock.net:443/rtv25/rtv/playlist.m3u8');
setupHlsPlayerOverlay('kc2-video', 'kc2-overlay', 'https://5c46fa289c89f.streamlock.net:443/kc2/kc2/playlist.m3u8');

function setupAudioPlayerOverlay(audioId, overlayId, audioUrl) {
  const audio = document.getElementById(audioId);
  const overlay = document.getElementById(overlayId);

  if (!audio || !overlay) return;

  function showOverlay() {
    overlay.removeAttribute('hidden');
    audio.removeAttribute('src'); // Strictly stop data buffering
    audio.load();
  }

  function hideOverlay() {
    overlay.setAttribute('hidden', '');
  }

  function stopAudioStream() {
    showOverlay();
  }

  // Register with orchestrator
  registerMedia(audioId, stopAudioStream);

  function startAudioStream() {
    stopAllMedia(audioId);
    audio.src = audioUrl;
    audio.play();
    hideOverlay();
  }

  overlay.addEventListener('click', startAudioStream);

  // If the user clicks pause on the native controls, we intercept it and reset
  audio.addEventListener('pause', function() {
    // Only show overlay if we actually have a source (prevents loops on load)
    if (audio.hasAttribute('src')) {
      showOverlay();
    }
  });

  // Init state
  showOverlay();
}

setupAudioPlayerOverlay('radio-rwanda', 'radio-rwanda-overlay', 'https://listen.rba.co.rw:8008/rwanda');
setupAudioPlayerOverlay('magic-fm', 'magic-fm-overlay', 'https://listen.rba.co.rw:8085/mgcfm');

// Detect interactions with iframes (since we can't detect 'play' directly inside them)
window.addEventListener('blur', () => {
  // If the active element is an iframe we manage, stop other media
  setTimeout(() => {
    const activeElement = document.activeElement;
    if (activeElement && activeElement.tagName === 'IFRAME') {
      if (mediaStopRegistry[activeElement.id] && activeMediaId !== activeElement.id) {
        stopAllMedia(activeElement.id);
      }
    }
  }, 0);
});

// Register Iframes (TV Garden, B&B FM)
['tv-garden-iframe', 'bb-fm-iframe'].forEach(iframeId => {
  const iframeElement = document.getElementById(iframeId);
  if (iframeElement) {
    const originalSrc = iframeElement.src;
    registerMedia(iframeId, () => {
      // Temporarily set src to about:blank to stop the stream, then restore it
      const currentSrc = iframeElement.src;
      if (currentSrc && currentSrc !== 'about:blank') {
        iframeElement.src = 'about:blank';
        setTimeout(() => {
          iframeElement.src = originalSrc;
        }, 100); // small delay before restoring
      }
    });
  }
});
