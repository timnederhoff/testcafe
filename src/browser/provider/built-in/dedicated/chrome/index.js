import OS from 'os-family';
import { parse as parseUrl } from 'url';
import dedicatedProviderBase from '../base';
import ChromeRunTimeInfo from './runtime-info';
import getConfig from './config';
import {
    start as startLocalChrome,
    startOnDocker as startLocalChromeOnDocker,
    stop as stopLocalChrome,
} from './local-chrome';
import { GET_WINDOW_DIMENSIONS_INFO_SCRIPT } from '../../../utils/client-functions';
import { BrowserClient } from './cdp-client';
import ResourceInjector from '../../../../../proxyless/resource-injector';

const MIN_AVAILABLE_DIMENSION = 50;

export default {
    ...dedicatedProviderBase,

    getConfig (name) {
        return getConfig(name);
    },

    _getBrowserProtocolClient (runtimeInfo) {
        return runtimeInfo.browserClient;
    },

    async _createRunTimeInfo (hostName, config, disableMultipleWindows) {
        return ChromeRunTimeInfo.create(hostName, config, disableMultipleWindows);
    },

    _setUserAgentMetaInfoForEmulatingDevice (browserId, config) {
        const { emulation, deviceName } = config;
        const isDeviceEmulation         = emulation && deviceName;

        if (!isDeviceEmulation)
            return;

        const metaInfo = `Emulating ${deviceName}`;
        const options  = {
            appendToUserAgent: true,
        };

        this.setUserAgentMetaInfo(browserId, metaInfo, options);
    },

    async _setupProxyless (browserId, browserClient) {
        const resourceInjector = new ResourceInjector(browserId);
        const cdpClient        = await browserClient.getActiveClient();

        await resourceInjector.setup(cdpClient);
    },

    async openBrowser (browserId, pageUrl, config, disableMultipleWindows, proxyless) {
        const parsedPageUrl = parseUrl(pageUrl);
        const runtimeInfo   = await this._createRunTimeInfo(parsedPageUrl.hostname, config, disableMultipleWindows);

        runtimeInfo.browserName = this._getBrowserName();
        runtimeInfo.browserId   = browserId;

        runtimeInfo.providerMethods = {
            resizeLocalBrowserWindow: (...args) => this.resizeLocalBrowserWindow(...args),
            reportWarning:            (...args) => this.reportWarning(browserId, ...args),
        };

        //NOTE: A not-working tab is opened when the browser start in the docker so we should create a new tab.
        if (runtimeInfo.inDocker)
            await startLocalChromeOnDocker(pageUrl, runtimeInfo);
        else
            await startLocalChrome(pageUrl, runtimeInfo);

        await this.waitForConnectionReady(browserId);

        runtimeInfo.viewportSize      = await this.runInitScript(browserId, GET_WINDOW_DIMENSIONS_INFO_SCRIPT);
        runtimeInfo.activeWindowId    = null;
        runtimeInfo.windowDescriptors = {};

        if (!disableMultipleWindows)
            runtimeInfo.activeWindowId = this.calculateWindowId();

        const browserClient = new BrowserClient(runtimeInfo);

        this.openedBrowsers[browserId] = runtimeInfo;

        await browserClient.init();

        await this._ensureWindowIsExpanded(browserId, runtimeInfo.viewportSize);

        this._setUserAgentMetaInfoForEmulatingDevice(browserId, runtimeInfo.config);

        if (proxyless)
            await this._setupProxyless(browserId, browserClient);
    },

    async closeBrowser (browserId, closingInfo = {}) {
        const runtimeInfo = this.openedBrowsers[browserId];

        if (runtimeInfo.browserClient.isHeadlessTab())
            await runtimeInfo.browserClient.closeTab();
        else
            await this.closeLocalBrowser(browserId);

        if (OS.mac || runtimeInfo.config.headless)
            await stopLocalChrome(runtimeInfo);

        if (runtimeInfo.tempProfileDir && !closingInfo.isRestarting)
            await runtimeInfo.tempProfileDir.dispose();

        delete this.openedBrowsers[browserId];
    },

    async resizeWindow (browserId, width, height, currentWidth, currentHeight) {
        const runtimeInfo = this.openedBrowsers[browserId];

        if (runtimeInfo.config.mobile)
            await runtimeInfo.browserClient.updateMobileViewportSize();
        else {
            runtimeInfo.viewportSize.width  = currentWidth;
            runtimeInfo.viewportSize.height = currentHeight;
        }

        await runtimeInfo.browserClient.resizeWindow({ width, height });
    },

    async startCapturingVideo (browserId) {
        const { browserClient } = this.openedBrowsers[browserId];

        await browserClient.startCapturingVideo();
    },

    async stopCapturingVideo (browserId) {
        const { browserClient } = this.openedBrowsers[browserId];

        await browserClient.stopCapturingVideo();
    },

    async getVideoFrameData (browserId) {
        const { browserClient } = this.openedBrowsers[browserId];

        return browserClient.getVideoFrameData();
    },

    async hasCustomActionForBrowser (browserId) {
        const { config, browserClient } = this.openedBrowsers[browserId];
        const client                    = await browserClient.getActiveClient();

        return {
            hasCloseBrowser:                true,
            hasResizeWindow:                !!client && (config.emulation || config.headless),
            hasMaximizeWindow:              !!client && config.headless,
            hasTakeScreenshot:              !!client,
            hasChromelessScreenshots:       !!client,
            hasGetVideoFrameData:           !!client,
            hasCanResizeWindowToDimensions: false,
        };
    },

    async _ensureWindowIsExpanded (browserId, { height, width, availableHeight, availableWidth, outerWidth, outerHeight }) {
        if (height < MIN_AVAILABLE_DIMENSION || width < MIN_AVAILABLE_DIMENSION) {
            const newHeight = Math.max(availableHeight, MIN_AVAILABLE_DIMENSION);
            const newWidth  = Math.max(Math.floor(availableWidth / 2), MIN_AVAILABLE_DIMENSION);

            await this.resizeWindow(browserId, newWidth, newHeight, outerWidth, outerHeight);
        }
    },
};
