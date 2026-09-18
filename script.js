const MEDIA_PERF_METRICS = {
  lcp: null,
  inp: null,
  firstInteractionToPlayMs: null,
  streamStartLatencyMs: {},
  retries: {}
};

window.kagirInkuruPerfMetrics = MEDIA_PERF_METRICS;

(function setupPerformanceObservers() {
  if ('PerformanceObserver' in window) {
    try {
      const lcpObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const latest = entries[entries.length - 1];
        if (latest) {
          MEDIA_PERF_METRICS.lcp = Math.round(latest.startTime);
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

      const inpObserver = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (entry.interactionId && (!MEDIA_PERF_METRICS.inp || entry.duration > MEDIA_PERF_METRICS.inp)) {
            MEDIA_PERF_METRICS.inp = Math.round(entry.duration);
          }
        }
      });
      inpObserver.observe({ type: 'event', durationThreshold: 40, buffered: true });
    } catch (error) {
      // Ignore unsupported observer types.
    }
  }

  let firstInteractionTimestamp = null;
  window.addEventListener('pointerdown', () => {
    if (firstInteractionTimestamp === null) {
      firstInteractionTimestamp = performance.now();
    }
  }, { passive: true, once: true });

  window.recordFirstInteractionToPlay = function recordFirstInteractionToPlay() {
    if (firstInteractionTimestamp !== null && MEDIA_PERF_METRICS.firstInteractionToPlayMs === null) {
      MEDIA_PERF_METRICS.firstInteractionToPlayMs = Math.round(performance.now() - firstInteractionTimestamp);
    }
  };
})();

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

function updateMediaStatus(statusElement, message, stateClass) {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.classList.remove('is-live', 'is-error');
  if (stateClass) {
    statusElement.classList.add(stateClass);
  }
}

function markWrapperReady(wrapper) {
  if (wrapper) {
    wrapper.classList.add('media-ready');
  }
}

function createHlsInstance(video, hlsUrl, handlers) {
  if (typeof Hls === 'undefined' || !Hls.isSupported()) {
    return null;
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: true,
    backBufferLength: 30,
    maxBufferLength: 20,
    capLevelToPlayerSize: true,
    startLevel: -1,
    testBandwidth: true,
    manifestLoadingTimeOut: 10000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 10000,
    fragLoadingTimeOut: 20000
  });

  hls.loadSource(hlsUrl);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, function () {
    handlers.onManifestParsed(hls);
  });

  hls.on(Hls.Events.ERROR, function (event, data) {
    handlers.onError(hls, data);
  });

  return hls;
}

function setupHlsPlayerOverlay(videoId, overlayId, statusId, hlsUrl) {
  const video = document.getElementById(videoId);
  const overlay = document.getElementById(overlayId);
  const status = document.getElementById(statusId);
  const wrapper = video ? video.closest('.video-wrapper') : null;

  if (!video || !overlay) return;

  let hlsInstance = null;
  let hlsLoaded = false;
  let nativeHlsMode = false;
  let streamStartTimestamp = null;
  let retryCount = 0;

  function showOverlay() {
    overlay.removeAttribute('hidden');
  }

  function hideOverlay() {
    overlay.setAttribute('hidden', '');
  }

  function setConnectingState() {
    updateMediaStatus(status, 'Connecting…');
    streamStartTimestamp = performance.now();
  }

  function setBufferingState() {
    updateMediaStatus(status, 'Buffering…');
  }

  function setLiveState() {
    updateMediaStatus(status, 'Live', 'is-live');
    markWrapperReady(wrapper);
    if (typeof window.recordFirstInteractionToPlay === 'function') {
      window.recordFirstInteractionToPlay();
    }
    if (streamStartTimestamp !== null) {
      MEDIA_PERF_METRICS.streamStartLatencyMs[videoId] = Math.round(performance.now() - streamStartTimestamp);
      streamStartTimestamp = null;
    }
  }

  function setErrorState() {
    updateMediaStatus(status, 'Retrying…', 'is-error');
  }

  function scheduleRetry() {
    if (retryCount >= 3) {
      updateMediaStatus(status, 'Tap to retry', 'is-error');
      showOverlay();
      return;
    }

    retryCount += 1;
    MEDIA_PERF_METRICS.retries[videoId] = retryCount;
    const delay = Math.min(4000, 400 * (2 ** (retryCount - 1)));
    setErrorState();

    window.setTimeout(() => {
      if (activeMediaId === videoId) {
        startStream({ fromRetry: true });
      }
    }, delay);
  }

  function destroyHls() {
    if (hlsInstance && typeof hlsInstance.destroy === 'function') {
      hlsInstance.destroy();
    }
    hlsInstance = null;
    hlsLoaded = false;
  }

  function stopStream() {
    destroyHls();
    video.pause();
    video.removeAttribute('src');
    video.load();
    retryCount = 0;
    nativeHlsMode = false;
    showOverlay();
    updateMediaStatus(status, 'Tap to play');
  }

  function handleFatalError(failedInstance, data) {
    if (failedInstance && failedInstance !== hlsInstance) {
      if (typeof failedInstance.destroy === 'function') {
        failedInstance.destroy();
      }
      showOverlay();
      scheduleRetry();
      return;
    }

    destroyHls();

    if (data && data.type === 'mediaError' && failedInstance && typeof failedInstance.recoverMediaError === 'function') {
      failedInstance.recoverMediaError();
      setBufferingState();
      return;
    }

    if (data && failedInstance && typeof failedInstance.startLoad === 'function') {
      failedInstance.startLoad();
      setBufferingState();
      return;
    }

    showOverlay();
    scheduleRetry();
  }

  function startStream(options = {}) {
    const { fromRetry = false } = options;

    stopAllMedia(videoId);
    hideOverlay();
    setConnectingState();

    if (!fromRetry) {
      retryCount = 0;
    }

    if (!hlsLoaded) {
      hlsInstance = createHlsInstance(video, hlsUrl, {
        onManifestParsed: () => {
          hlsLoaded = true;
          video.play().catch(() => {
            showOverlay();
            updateMediaStatus(status, 'Tap to resume');
          });
        },
        onError: (instance, data) => {
          if (data && data.fatal) {
            handleFatalError(instance, data);
          } else {
            setBufferingState();
          }
        }
      });

      if (!hlsInstance) {
        nativeHlsMode = video.canPlayType('application/vnd.apple.mpegurl') !== '';
        video.src = hlsUrl;
        video.addEventListener('loadedmetadata', function handleLoadedMetadata() {
          video.removeEventListener('loadedmetadata', handleLoadedMetadata);
          hlsLoaded = true;
          video.play().catch(() => {
            showOverlay();
            updateMediaStatus(status, 'Tap to resume');
          });
        });
      }
    } else {
      if (nativeHlsMode) {
        video.src = hlsUrl;
      }
      video.play().catch(() => {
        showOverlay();
        updateMediaStatus(status, 'Tap to resume');
      });
    }
  }

  registerMedia(videoId, stopStream);

  overlay.addEventListener('click', () => startStream());
  video.addEventListener('play', () => {
    hideOverlay();
    setLiveState();
  });
  video.addEventListener('waiting', setBufferingState);
  video.addEventListener('stalled', setBufferingState);
  video.addEventListener('canplay', setLiveState);
  video.addEventListener('pause', function handlePause() {
    if (video.currentTime === 0 || video.ended) {
      showOverlay();
      updateMediaStatus(status, 'Tap to play');
    }
  });

  showOverlay();
  updateMediaStatus(status, 'Tap to play');
}

function setupAudioPlayerOverlay(audioId, overlayId, statusId, audioUrl) {
  const audio = document.getElementById(audioId);
  const overlay = document.getElementById(overlayId);
  const status = document.getElementById(statusId);
  const wrapper = audio ? audio.closest('.audio-wrapper') : null;

  if (!audio || !overlay) return;

  let retryCount = 0;
  let streamStartTimestamp = null;

  function showOverlay() {
    overlay.removeAttribute('hidden');
  }

  function hideOverlay() {
    overlay.setAttribute('hidden', '');
  }

  function stopAudioStream() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    retryCount = 0;
    showOverlay();
    updateMediaStatus(status, 'Tap to play');
  }

  registerMedia(audioId, stopAudioStream);

  function startAudioStream(fromRetry = false) {
    stopAllMedia(audioId);
    hideOverlay();

    if (!fromRetry) {
      retryCount = 0;
    }

    updateMediaStatus(status, 'Connecting…');
    streamStartTimestamp = performance.now();
    audio.src = audioUrl;
    audio.play().catch(() => {
      showOverlay();
      updateMediaStatus(status, 'Tap to resume');
    });
  }

  function scheduleAudioRetry() {
    if (retryCount >= 2) {
      updateMediaStatus(status, 'Tap to retry', 'is-error');
      showOverlay();
      return;
    }

    retryCount += 1;
    MEDIA_PERF_METRICS.retries[audioId] = retryCount;
    const delay = Math.min(3000, 500 * (2 ** (retryCount - 1)));
    updateMediaStatus(status, 'Retrying…', 'is-error');

    window.setTimeout(() => {
      if (activeMediaId === audioId) {
        startAudioStream(true);
      }
    }, delay);
  }

  overlay.addEventListener('click', () => startAudioStream());

  audio.addEventListener('play', () => {
    hideOverlay();
    markWrapperReady(wrapper);
    updateMediaStatus(status, 'Live', 'is-live');
    if (typeof window.recordFirstInteractionToPlay === 'function') {
      window.recordFirstInteractionToPlay();
    }
    if (streamStartTimestamp !== null) {
      MEDIA_PERF_METRICS.streamStartLatencyMs[audioId] = Math.round(performance.now() - streamStartTimestamp);
      streamStartTimestamp = null;
    }
  });

  audio.addEventListener('waiting', () => updateMediaStatus(status, 'Buffering…'));
  audio.addEventListener('stalled', () => updateMediaStatus(status, 'Buffering…'));
  audio.addEventListener('canplay', () => updateMediaStatus(status, 'Live', 'is-live'));
  audio.addEventListener('error', scheduleAudioRetry);

  audio.addEventListener('pause', function () {
    if (audio.hasAttribute('src') && !audio.ended) {
      showOverlay();
      updateMediaStatus(status, 'Tap to resume');
    }
  });

  audio.addEventListener('ended', () => {
    showOverlay();
    updateMediaStatus(status, 'Tap to play');
  });

  showOverlay();
  updateMediaStatus(status, 'Tap to play');
}

function lazyLoadIframes() {
  const iframes = Array.from(document.querySelectorAll('iframe[data-src]'));
  if (!iframes.length) return;

  const loadIframe = (iframe) => {
    if (!iframe || iframe.dataset.loaded === 'true') return;
    iframe.src = iframe.dataset.src;
    iframe.dataset.loaded = 'true';
  };

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting || entry.intersectionRatio > 0) {
          loadIframe(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '300px 0px' });

    iframes.forEach((iframe) => observer.observe(iframe));
  } else {
    iframes.forEach(loadIframe);
  }

  window.addEventListener('pointerdown', () => {
    loadIframe(iframes[0]);
  }, { once: true, passive: true });
}

function registerIframeMediaStops() {
  ['tv-garden-iframe', 'bb-fm-iframe'].forEach((iframeId) => {
    const iframeElement = document.getElementById(iframeId);
    if (!iframeElement) return;

    registerMedia(iframeId, () => {
      const currentSrc = iframeElement.src;
      if (!currentSrc || currentSrc === 'about:blank') return;
      iframeElement.src = 'about:blank';
      window.setTimeout(() => {
        if (iframeElement.dataset && iframeElement.dataset.src) {
          iframeElement.src = iframeElement.dataset.src;
        }
      }, 120);
    });
  });
}

function setupIframeInteractionDetection() {
  window.addEventListener('blur', () => {
    window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (activeElement && activeElement.tagName === 'IFRAME' && mediaStopRegistry[activeElement.id]) {
        if (activeMediaId !== activeElement.id) {
          stopAllMedia(activeElement.id);
        }
      }
    }, 0);
  });
}

function warmupFirstChannel() {
  const warmupUrl = 'https://5c46fa289c89f.streamlock.net:443/rtv25/rtv/playlist.m3u8';
  const runWarmup = () => {
    fetch(warmupUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {
      // Ignore warmup failures.
    });
  };

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(runWarmup, { timeout: 2000 });
  } else {
    window.setTimeout(runWarmup, 400);
  }
}

setupHlsPlayerOverlay('rtv-video', 'rtv-overlay', 'rtv-status', 'https://5c46fa289c89f.streamlock.net:443/rtv25/rtv/playlist.m3u8');
setupHlsPlayerOverlay('kc2-video', 'kc2-overlay', 'kc2-status', 'https://5c46fa289c89f.streamlock.net:443/kc2/kc2/playlist.m3u8');
setupAudioPlayerOverlay('radio-rwanda', 'radio-rwanda-overlay', 'radio-rwanda-status', 'https://listen.rba.co.rw:8008/rwanda');
setupAudioPlayerOverlay('magic-fm', 'magic-fm-overlay', 'magic-fm-status', 'https://listen.rba.co.rw:8085/mgcfm');

lazyLoadIframes();
registerIframeMediaStops();
setupIframeInteractionDetection();
warmupFirstChannel();
