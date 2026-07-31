function setupHlsStream(video, hlsUrl, onFatalError) {
  let hlsInstance = null;
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsInstance = new Hls();
    hlsInstance.loadSource(hlsUrl);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
      video.play();
    });
    hlsInstance.on(Hls.Events.ERROR, function (event, data) {
      if (data.fatal) {
        onFatalError(hlsInstance);
      }
    });
    return true;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = hlsUrl;
    video.addEventListener('loadedmetadata', function () {
      video.play();
    });
    return true;
  }
  return false;
}

function setupHlsPlayerOverlay(videoId, overlayId, hlsUrl) {
  const video = document.getElementById(videoId);
  const overlay = document.getElementById(overlayId);
  let hlsLoaded = false;

  function showOverlay() {
    overlay.removeAttribute('hidden');
    video.pause();
    video.currentTime = 0;
    video.load();
  }
  function hideOverlay() {
    overlay.setAttribute('hidden', '');
  }

  function handleFatalError(hlsInstance) {
    showOverlay();
    if (hlsInstance) {
      hlsInstance.destroy();
    }
    hlsLoaded = false;
  }

  function startStream() {
    if (!hlsLoaded) {
      hlsLoaded = setupHlsStream(video, hlsUrl, handleFatalError);
      if (!hlsLoaded) {
        // Fallback for browsers that do not support HLS
        video.src = hlsUrl;
        video.play();
      }
    } else {
      video.play();
    }
    hideOverlay();
  }

  function handlePause() {
    if (video.currentTime === 0 || video.ended) {
      showOverlay();
    }
  }

  overlay.addEventListener('click', startStream);
  video.addEventListener('play', hideOverlay);
  video.addEventListener('pause', handlePause);

  // Show overlay on load
  showOverlay();
}

setupHlsPlayerOverlay('rtv-video', 'rtv-overlay', 'https://5c46fa289c89f.streamlock.net:443/rtv25/rtv/playlist.m3u8');
setupHlsPlayerOverlay('kc2-video', 'kc2-overlay', 'https://5c46fa289c89f.streamlock.net:443/kc2/kc2/playlist.m3u8');
