import subprocess
import time
import unittest
from playwright.sync_api import sync_playwright

class TestHLSSupport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Start a local server to serve the files
        cls.server_process = subprocess.Popen(
            ["python3", "-m", "http.server", "8000"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        # Wait for the server to be ready
        max_retries = 10
        for i in range(max_retries):
            try:
                import urllib.request
                urllib.request.urlopen("http://localhost:8000", timeout=1)
                break
            except:
                time.sleep(1)
        else:
            raise Exception("Server failed to start")

    @classmethod
    def tearDownClass(cls):
        cls.server_process.terminate()
        cls.server_process.wait()

    @staticmethod
    def block_external(route):
        """Block ALL external requests to prevent timeouts caused by slow external assets."""
        url = route.request.url
        if "localhost" in url:
            route.continue_()
        else:
            route.abort()

    def test_hls_not_supported_fallback(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            # Mock Hls.isSupported to return false
            page.add_init_script('''
                window.Hls = {
                    isSupported: () => false
                };
            ''')

            # Block ALL external requests
            page.route("**/*", self.block_external)

            # Navigate to the page
            page.goto("http://localhost:8000", wait_until="commit")

            # Wait for our scripts to load
            page.wait_for_selector(".play-overlay", state="attached")

            # Spy on video.play and video.src
            # We use a general selector to find a video element and its overlay
            page.evaluate('''
                window.playCalled = false;
                window.srcSet = null;

                window.originalCanPlayType = HTMLVideoElement.prototype.canPlayType;
                HTMLVideoElement.prototype.canPlayType = function(type) {
                    if (type === 'application/vnd.apple.mpegurl') {
                        return 'probably';
                    }
                    return window.originalCanPlayType.call(this, type);
                };

                const video = document.querySelector('video');

                const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
                Object.defineProperty(video, 'src', {
                    set: function(val) {
                        window.srcSet = val;
                        origSrcDescriptor.set.call(this, val);
                    },
                    get: function() {
                        return origSrcDescriptor.get.call(this);
                    }
                });

                video.play = function() {
                    window.playCalled = true;
                    return Promise.resolve();
                };
            ''')

            # Click the first overlay
            page.dispatch_event(".play-overlay", "click")

            # Dispatch loadedmetadata since canPlayType sets src and waits for this event
            page.evaluate('''
                const video = document.querySelector('video');
                if (video.src) {
                    video.dispatchEvent(new Event('loadedmetadata'));
                }
            ''')

            # Check if play was called
            play_called = page.evaluate("window.playCalled")
            src_set = page.evaluate("window.srcSet")

            self.assertTrue(play_called, "video.play() should be called even if HLS is not supported")
            self.assertIsNotNone(src_set, "Source should be set in fallback case")
            self.assertTrue(src_set.endswith('.m3u8'), f"Source should be set to an HLS URL (.m3u8) in fallback case, got {src_set}")

            # Restore mocked global to avoid cross-test effects
            page.evaluate('''() => {
                HTMLVideoElement.prototype.canPlayType = window.originalCanPlayType;
            }''')
            browser.close()

    def test_hls_supported_initialization(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            # Mock Hls.isSupported to return true and mock Hls constructor
            page.add_init_script('''
                window.hlsInstances = [];
                window.Hls = class {
                    static isSupported() { return true; }
                    constructor() {
                        this.url = null;
                        window.hlsInstances.push(this);
                    }
                    loadSource(url) { this.url = url; }
                    attachMedia(media) { this.media = media; }
                    on(event, callback) {
                        if (event === 'hlsManifestParsed') {
                            this.manifestParsedCallback = callback;
                        }
                    }
                    destroy() {}
                };
                window.Hls.Events = {
                    MANIFEST_PARSED: 'hlsManifestParsed',
                    ERROR: 'hlsError'
                };
            ''')

            # Block ALL external requests
            page.route("**/*", self.block_external)

            page.goto("http://localhost:8000", wait_until="commit")
            page.wait_for_selector(".play-overlay", state="attached")

            # Click the first overlay
            page.dispatch_event(".play-overlay", "click")

            # Verify Hls instance was created and configured
            hls_info = page.evaluate('''
                () => {
                    if (window.hlsInstances.length === 0) return null;
                    const inst = window.hlsInstances[0];
                    return {
                        url: inst.url,
                        hasMedia: !!inst.media
                    };
                }
            ''')

            self.assertIsNotNone(hls_info)
            self.assertTrue(hls_info['url'].endswith('.m3u8'))
            self.assertTrue(hls_info['hasMedia'])

            browser.close()

    def test_overlay_state_on_events(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            # Mock Hls.isSupported to return false to easily control play event
            page.add_init_script('''
                window.Hls = {
                    isSupported: () => false
                };
            ''')

            # Block ALL external requests
            page.route("**/*", self.block_external)

            page.goto("http://localhost:8000", wait_until="commit")
            page.wait_for_selector(".play-overlay", state="attached")

            # Check initial state: overlay should be visible
            overlay_hidden_initially = page.evaluate("document.querySelector('#rtv-overlay').hasAttribute('hidden')")
            self.assertFalse(overlay_hidden_initially, "Overlay should be visible initially")

            # Trigger play event manually to simulate play starting and verify overlay hides
            page.evaluate('''
                const video = document.querySelector('#rtv-video');
                video.dispatchEvent(new Event('play'));
            ''')

            overlay_hidden_after_play = page.evaluate("document.querySelector('#rtv-overlay').hasAttribute('hidden')")
            self.assertTrue(overlay_hidden_after_play, "Overlay should be hidden after play event")

            # Trigger pause event with currentTime > 0 and not ended
            page.evaluate('''
                const video = document.querySelector('#rtv-video');
                video.currentTime = 10;
                Object.defineProperty(video, 'ended', { value: false });
                video.dispatchEvent(new Event('pause'));
            ''')

            overlay_hidden_after_pause_middle = page.evaluate("document.querySelector('#rtv-overlay').hasAttribute('hidden')")
            self.assertTrue(overlay_hidden_after_pause_middle, "Overlay should stay hidden when paused in the middle")

            # Trigger pause event with currentTime == 0
            page.evaluate('''
                const video = document.querySelector('#rtv-video');
                video.currentTime = 0;
                video.dispatchEvent(new Event('pause'));
            ''')

            overlay_hidden_after_pause_start = page.evaluate("document.querySelector('#rtv-overlay').hasAttribute('hidden')")
            self.assertFalse(overlay_hidden_after_pause_start, "Overlay should be visible when paused at the start")

            browser.close()

    def test_hls_fatal_error(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            # Mock Hls.isSupported to return true and mock Hls constructor
            page.add_init_script('''
                window.hlsInstances = [];
                window.Hls = class {
                    static isSupported() { return true; }
                    constructor() {
                        this.url = null;
                        this.destroyed = false;
                        window.hlsInstances.push(this);
                    }
                    loadSource(url) { this.url = url; }
                    attachMedia(media) { this.media = media; }
                    on(event, callback) {
                        if (event === 'hlsManifestParsed') {
                            this.manifestParsedCallback = callback;
                        } else if (event === 'hlsError') {
                            this.errorCallback = callback;
                        }
                    }
                    destroy() { this.destroyed = true; }
                };
                window.Hls.Events = {
                    MANIFEST_PARSED: 'hlsManifestParsed',
                    ERROR: 'hlsError'
                };
            ''')

            # Block ALL external requests
            page.route("**/*", self.block_external)

            page.goto("http://localhost:8000", wait_until="commit")
            page.wait_for_selector(".play-overlay", state="attached")

            # Click the first overlay
            page.dispatch_event(".play-overlay", "click")

            # Emulate HLS Fatal Error and check overlay
            result = page.evaluate('''
                () => {
                    const inst = window.hlsInstances[0];
                    if (inst && inst.errorCallback) {
                        // Call the error callback with a fatal error
                        inst.errorCallback('hlsError', { fatal: true });

                        // Check if overlay is shown
                        const overlay = document.querySelector('.play-overlay');
                        const isHidden = overlay.hasAttribute('hidden');

                        return {
                            overlayHidden: isHidden,
                            hlsDestroyed: inst.destroyed
                        };
                    }
                    return null;
                }
            ''')

            self.assertIsNotNone(result)
            self.assertFalse(result['overlayHidden'], "Overlay should be visible after fatal error")
            self.assertTrue(result['hlsDestroyed'], "Hls instance should be destroyed after fatal error")

            browser.close()

if __name__ == "__main__":
    unittest.main()
