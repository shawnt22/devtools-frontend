import { assert } from './assert.js';
import { debugError , helper} from './helper.js';

/**
 *
 * Represents an HTTP request sent by a page.
 * @remarks
 *
 * Whenever the page sends a request, such as for a network resource, the
 * following events are emitted by Puppeteer's `page`:
 *
 * - `request`:  emitted when the request is issued by the page.
 * - `requestfinished` - emitted when the response body is downloaded and the
 *   request is complete.
 *
 * If request fails at some point, then instead of `requestfinished` event the
 * `requestfailed` event is emitted.
 *
 * All of these events provide an instance of `HTTPRequest` representing the
 * request that occurred:
 *
 * ```
 * page.on('request', request => ...)
 * ```
 *
 * NOTE: HTTP Error responses, such as 404 or 503, are still successful
 * responses from HTTP standpoint, so request will complete with
 * `requestfinished` event.
 *
 * If request gets a 'redirect' response, the request is successfully finished
 * with the `requestfinished` event, and a new request is issued to a
 * redirected url.
 *
 * @public
 */
export class HTTPRequest {
    /**
     * @internal
     */
    constructor(client, frame, interceptionId, allowInterception, event, redirectChain) {
        /**
         * @internal
         */
        this._failureText = null;
        /**
         * @internal
         */
        this._response = null;
        /**
         * @internal
         */
        this._fromMemoryCache = false;
        this._interceptionHandled = false;
        this._headers = {};
        this._client = client;
        this._requestId = event.requestId;
        this._isNavigationRequest =
            event.requestId === event.loaderId && event.type === 'Document';
        this._interceptionId = interceptionId;
        this._allowInterception = allowInterception;
        this._url = event.request.url;
        this._resourceType = event.type.toLowerCase();
        this._method = event.request.method;
        this._postData = event.request.postData;
        this._frame = frame;
        this._redirectChain = redirectChain;
        this._continueRequestOverrides = {};
        this._currentStrategy = 'none';
        this._currentPriority = undefined;
        this._interceptActions = [];
        for (const key of Object.keys(event.request.headers))
            this._headers[key.toLowerCase()] = event.request.headers[key];
    }
    /**
     * @returns the URL of the request
     */
    url() {
        return this._url;
    }
    /**
     * @returns the `ContinueRequestOverrides` that will be used
     * if the interception is allowed to continue (ie, `abort()` and
     * `respond()` aren't called).
     */
    continueRequestOverrides() {
        assert(this._allowInterception, 'Request Interception is not enabled!');
        return this._continueRequestOverrides;
    }
    /**
     * @returns The `ResponseForRequest` that gets used if the
     * interception is allowed to respond (ie, `abort()` is not called).
     */
    responseForRequest() {
        assert(this._allowInterception, 'Request Interception is not enabled!');
        return this._responseForRequest;
    }
    /**
     * @returns the most recent reason for aborting the request
     */
    abortErrorReason() {
        assert(this._allowInterception, 'Request Interception is not enabled!');
        return this._abortErrorReason;
    }
    /**
     * @returns An array of the current intercept resolution strategy and priority
     * `[strategy,priority]`. Strategy is one of: `abort`, `respond`, `continue`,
     *  `disabled`, `none`, or `already-handled`.
     */
    interceptResolution() {
        if (!this._allowInterception)
            return ['disabled'];
        if (this._interceptionHandled)
            return ['alreay-handled'];
        return [this._currentStrategy, this._currentPriority];
    }
    /**
     * Adds an async request handler to the processing queue.
     * Deferred handlers are not guaranteed to execute in any particular order,
     * but they are guarnateed to resolve before the request interception
     * is finalized.
     */
    enqueueInterceptAction(pendingHandler) {
        this._interceptActions.push(pendingHandler);
    }
    /**
     * Awaits pending interception handlers and then decides how to fulfill
     * the request interception.
     */
    async finalizeInterceptions() {
        await this._interceptActions.reduce((promiseChain, interceptAction) => promiseChain.then(interceptAction).catch((error) => {
            // This is here so cooperative handlers that fail do not stop other handlers
            // from running
            debugError(error);
        }), Promise.resolve());
        const [resolution] = this.interceptResolution();
        switch (resolution) {
            case 'abort':
                return this._abort(this._abortErrorReason);
            case 'respond':
                return this._respond(this._responseForRequest);
            case 'continue':
                return this._continue(this._continueRequestOverrides);
        }
    }
    /**
     * Contains the request's resource type as it was perceived by the rendering
     * engine.
     */
    resourceType() {
        return this._resourceType;
    }
    /**
     * @returns the method used (`GET`, `POST`, etc.)
     */
    method() {
        return this._method;
    }
    /**
     * @returns the request's post body, if any.
     */
    postData() {
        return this._postData;
    }
    /**
     * @returns an object with HTTP headers associated with the request. All
     * header names are lower-case.
     */
    headers() {
        return this._headers;
    }
    /**
     * @returns A matching `HTTPResponse` object, or null if the response has not
     * been received yet.
     */
    response() {
        return this._response;
    }
    /**
     * @returns the frame that initiated the request, or null if navigating to
     * error pages.
     */
    frame() {
        return this._frame;
    }
    /**
     * @returns true if the request is the driver of the current frame's navigation.
     */
    isNavigationRequest() {
        return this._isNavigationRequest;
    }
    /**
     * A `redirectChain` is a chain of requests initiated to fetch a resource.
     * @remarks
     *
     * `redirectChain` is shared between all the requests of the same chain.
     *
     * For example, if the website `http://example.com` has a single redirect to
     * `https://example.com`, then the chain will contain one request:
     *
     * ```js
     * const response = await page.goto('http://example.com');
     * const chain = response.request().redirectChain();
     * console.log(chain.length); // 1
     * console.log(chain[0].url()); // 'http://example.com'
     * ```
     *
     * If the website `https://google.com` has no redirects, then the chain will be empty:
     *
     * ```js
     * const response = await page.goto('https://google.com');
     * const chain = response.request().redirectChain();
     * console.log(chain.length); // 0
     * ```
     *
     * @returns the chain of requests - if a server responds with at least a
     * single redirect, this chain will contain all requests that were redirected.
     */
    redirectChain() {
        return this._redirectChain.slice();
    }
    /**
     * Access information about the request's failure.
     *
     * @remarks
     *
     * @example
     *
     * Example of logging all failed requests:
     *
     * ```js
     * page.on('requestfailed', request => {
     *   console.log(request.url() + ' ' + request.failure().errorText);
     * });
     * ```
     *
     * @returns `null` unless the request failed. If the request fails this can
     * return an object with `errorText` containing a human-readable error
     * message, e.g. `net::ERR_FAILED`. It is not guaranteeded that there will be
     * failure text if the request fails.
     */
    failure() {
        if (!this._failureText)
            return null;
        return {
            errorText: this._failureText,
        };
    }
    /**
     * Continues request with optional request overrides.
     *
     * @remarks
     *
     * To use this, request
     * interception should be enabled with {@link Page.setRequestInterception}.
     *
     * Exception is immediately thrown if the request interception is not enabled.
     *
     * @example
     * ```js
     * await page.setRequestInterception(true);
     * page.on('request', request => {
     *   // Override headers
     *   const headers = Object.assign({}, request.headers(), {
     *     foo: 'bar', // set "foo" header
     *     origin: undefined, // remove "origin" header
     *   });
     *   request.continue({headers});
     * });
     * ```
     *
     * @param overrides - optional overrides to apply to the request.
     * @param priority - If provided, intercept is resolved using
     * cooperative handling rules. Otherwise, intercept is resolved
     * immediately.
     */
    async continue(overrides = {}, priority) {
        // Request interception is not supported for data: urls.
        if (this._url.startsWith('data:'))
            return;
        assert(this._allowInterception, 'Request Interception is not enabled!');
        assert(!this._interceptionHandled, 'Request is already handled!');
        if (priority === undefined) {
            return this._continue(overrides);
        }
        this._continueRequestOverrides = overrides;
        if (priority > this._currentPriority ||
            this._currentPriority === undefined) {
            this._currentStrategy = 'continue';
            this._currentPriority = priority;
            return;
        }
        if (priority === this._currentPriority) {
            if (this._currentStrategy === 'abort' ||
                this._currentStrategy === 'respond') {
                return;
            }
            this._currentStrategy = 'continue';
        }
        return;
    }
    async _continue(overrides = {}) {
        const { url, method, postData, headers } = overrides;
        this._interceptionHandled = true;
        const postDataBinaryBase64 = postData
            ? Buffer.from(postData).toString('base64')
            : undefined;
        await this._client
            .send('Fetch.continueRequest', {
            requestId: this._interceptionId,
            url,
            method,
            postData: postDataBinaryBase64,
            headers: headers ? headersArray(headers) : undefined,
        })
            .catch((error) => {
            // In certain cases, protocol will return error if the request was
            // already canceled or the page was closed. We should tolerate these
            // errors.
            debugError(error);
        });
    }
    /**
     * Fulfills a request with the given response.
     *
     * @remarks
     *
     * To use this, request
     * interception should be enabled with {@link Page.setRequestInterception}.
     *
     * Exception is immediately thrown if the request interception is not enabled.
     *
     * @example
     * An example of fulfilling all requests with 404 responses:
     * ```js
     * await page.setRequestInterception(true);
     * page.on('request', request => {
     *   request.respond({
     *     status: 404,
     *     contentType: 'text/plain',
     *     body: 'Not Found!'
     *   });
     * });
     * ```
     *
     * NOTE: Mocking responses for dataURL requests is not supported.
     * Calling `request.respond` for a dataURL request is a noop.
     *
     * @param response - the response to fulfill the request with.
     * @param priority - If provided, intercept is resolved using
     * cooperative handling rules. Otherwise, intercept is resolved
     * immediately.
     */
    async respond(response, priority) {
        // Mocking responses for dataURL requests is not currently supported.
        if (this._url.startsWith('data:'))
            return;
        assert(this._allowInterception, 'Request Interception is not enabled!');
        assert(!this._interceptionHandled, 'Request is already handled!');
        if (priority === undefined) {
            return this._respond(response);
        }
        this._responseForRequest = response;
        if (priority > this._currentPriority ||
            this._currentPriority === undefined) {
            this._currentStrategy = 'respond';
            this._currentPriority = priority;
            return;
        }
        if (priority === this._currentPriority) {
            if (this._currentStrategy === 'abort') {
                return;
            }
            this._currentStrategy = 'respond';
        }
    }
    async _respond(response) {
        this._interceptionHandled = true;
        const responseBody = response.body && helper.isString(response.body)
            ? Buffer.from(response.body)
            : response.body || null;
        const responseHeaders = {};
        if (response.headers) {
            for (const header of Object.keys(response.headers))
                responseHeaders[header.toLowerCase()] = String(response.headers[header]);
        }
        if (response.contentType)
            responseHeaders['content-type'] = response.contentType;
        if (responseBody && !('content-length' in responseHeaders))
            responseHeaders['content-length'] = String(Buffer.byteLength(responseBody));
        await this._client
            .send('Fetch.fulfillRequest', {
            requestId: this._interceptionId,
            responseCode: response.status || 200,
            responsePhrase: STATUS_TEXTS[response.status || 200],
            responseHeaders: headersArray(responseHeaders),
            body: responseBody ? responseBody.toString('base64') : undefined,
        })
            .catch((error) => {
            // In certain cases, protocol will return error if the request was
            // already canceled or the page was closed. We should tolerate these
            // errors.
            debugError(error);
        });
    }
    /**
     * Aborts a request.
     *
     * @remarks
     * To use this, request interception should be enabled with
     * {@link Page.setRequestInterception}. If it is not enabled, this method will
     * throw an exception immediately.
     *
     * @param errorCode - optional error code to provide.
     * @param priority - If provided, intercept is resolved using
     * cooperative handling rules. Otherwise, intercept is resolved
     * immediately.
     */
    async abort(errorCode = 'failed', priority) {
        // Request interception is not supported for data: urls.
        if (this._url.startsWith('data:'))
            return;
        const errorReason = errorReasons[errorCode];
        assert(errorReason, 'Unknown error code: ' + errorCode);
        assert(this._allowInterception, 'Request Interception is not enabled!');
        assert(!this._interceptionHandled, 'Request is already handled!');
        if (priority === undefined) {
            return this._abort(errorReason);
        }
        this._abortErrorReason = errorReason;
        if (priority >= this._currentPriority ||
            this._currentPriority === undefined) {
            this._currentStrategy = 'abort';
            this._currentPriority = priority;
            return;
        }
    }
    async _abort(errorReason) {
        this._interceptionHandled = true;
        await this._client
            .send('Fetch.failRequest', {
            requestId: this._interceptionId,
            errorReason,
        })
            .catch((error) => {
            // In certain cases, protocol will return error if the request was
            // already canceled or the page was closed. We should tolerate these
            // errors.
            debugError(error);
        });
    }
}
const errorReasons = {
    aborted: 'Aborted',
    accessdenied: 'AccessDenied',
    addressunreachable: 'AddressUnreachable',
    blockedbyclient: 'BlockedByClient',
    blockedbyresponse: 'BlockedByResponse',
    connectionaborted: 'ConnectionAborted',
    connectionclosed: 'ConnectionClosed',
    connectionfailed: 'ConnectionFailed',
    connectionrefused: 'ConnectionRefused',
    connectionreset: 'ConnectionReset',
    internetdisconnected: 'InternetDisconnected',
    namenotresolved: 'NameNotResolved',
    timedout: 'TimedOut',
    failed: 'Failed',
};
function headersArray(headers) {
    const result = [];
    for (const name in headers) {
        if (!Object.is(headers[name], undefined))
            result.push({ name, value: headers[name] + '' });
    }
    return result;
}
// List taken from
// https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml
// with extra 306 and 418 codes.
const STATUS_TEXTS = {
    '100': 'Continue',
    '101': 'Switching Protocols',
    '102': 'Processing',
    '103': 'Early Hints',
    '200': 'OK',
    '201': 'Created',
    '202': 'Accepted',
    '203': 'Non-Authoritative Information',
    '204': 'No Content',
    '205': 'Reset Content',
    '206': 'Partial Content',
    '207': 'Multi-Status',
    '208': 'Already Reported',
    '226': 'IM Used',
    '300': 'Multiple Choices',
    '301': 'Moved Permanently',
    '302': 'Found',
    '303': 'See Other',
    '304': 'Not Modified',
    '305': 'Use Proxy',
    '306': 'Switch Proxy',
    '307': 'Temporary Redirect',
    '308': 'Permanent Redirect',
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '402': 'Payment Required',
    '403': 'Forbidden',
    '404': 'Not Found',
    '405': 'Method Not Allowed',
    '406': 'Not Acceptable',
    '407': 'Proxy Authentication Required',
    '408': 'Request Timeout',
    '409': 'Conflict',
    '410': 'Gone',
    '411': 'Length Required',
    '412': 'Precondition Failed',
    '413': 'Payload Too Large',
    '414': 'URI Too Long',
    '415': 'Unsupported Media Type',
    '416': 'Range Not Satisfiable',
    '417': 'Expectation Failed',
    '418': "I'm a teapot",
    '421': 'Misdirected Request',
    '422': 'Unprocessable Entity',
    '423': 'Locked',
    '424': 'Failed Dependency',
    '425': 'Too Early',
    '426': 'Upgrade Required',
    '428': 'Precondition Required',
    '429': 'Too Many Requests',
    '431': 'Request Header Fields Too Large',
    '451': 'Unavailable For Legal Reasons',
    '500': 'Internal Server Error',
    '501': 'Not Implemented',
    '502': 'Bad Gateway',
    '503': 'Service Unavailable',
    '504': 'Gateway Timeout',
    '505': 'HTTP Version Not Supported',
    '506': 'Variant Also Negotiates',
    '507': 'Insufficient Storage',
    '508': 'Loop Detected',
    '510': 'Not Extended',
    '511': 'Network Authentication Required',
};
//# sourceMappingURL=HTTPRequest.js.map