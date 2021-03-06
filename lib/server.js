"use strict";

/*
 * RESTBase web service entry point
 *
 * Sets up a restbase instance by loading and setting up handlers and the
 * storage layer, and then dispatches requests to it.
 */

var P = require('bluebird');

var rbUtil = require('./rbUtil');
var Restbase = require('./restbase');
var http = require('http');
var fs = require('fs');
var Router = require('./router');
var URI = require('swagger-router').URI;
var zlib = require('zlib');

function handleResponse (opts, req, resp, response) {
    //console.log('resp', response);
    if (response && response.status) {
        if (!response.headers) {
            response.headers = {};
        }

        var rh = response.headers;

        // Default to no server-side caching
        if (!rh['cache-control']) {
            rh['cache-control'] = 'private, max-age=0, s-maxage=0, must-revalidate';
        }

        // Set up CORS
        rh['Access-Control-Allow-Origin'] = '*';
        rh['Access-Control-Allow-Methods'] = 'GET';
        rh['Access-Control-Allow-Headers'] = 'accept, content-type';

        // Set up security headers
        // https://www.owasp.org/index.php/List_of_useful_HTTP_headers
        rh['X-Content-Type-Options'] = 'nosniff';
        rh['X-Frame-Options'] = 'SAMEORIGIN';

        if (!/^application\/json/.test(rh['content-type'])) {
            rh['X-XSS-Protection'] = '1; mode=block';
            if (!rh['Content-Security-Policy']) {
                rh['Content-Security-Policy'] =
                    "default-src 'none'; media-src *; img-src *; style-src *; frame-ancestors 'self'";
            }
            // For IE 10 & 11
            rh['X-Content-Security-Policy'] = rh['Content-Security-Policy'];
            // For Chrome <= v25 (seems to be <1% traffic; should we still
            // care?)
            rh['X-WebKit-CSP'] = rh['Content-Security-Policy'];
        }

        // propagate the request id header
        rh['X-Request-Id'] = opts.reqId;

        var logLevel = 'trace/request';
        if (response.status >= 500) {
            logLevel = 'error/request';
        } else if (response.status >= 400) {
            logLevel = 'info/request';
        }
        opts.log(logLevel, {
            message: response.message,
            req: req,
            res: response,
            stack: response.stack
        });

        var body;
        // Prepare error responses for the client
        if (response.status >= 400) {
            if (!response.body) {
                response.body = {};
            }
            // whitelist fields to avoid leaking sensitive info
            var rBody = response.body;
            body = {
                type: rBody.type,
                title: rBody.title,
                method: rBody.method,
                detail: rBody.detail || rBody.description,
                uri: rBody.uri
            };

            if (!response.headers['content-type']) {
                response.headers['content-type'] = 'application/problem+json';
            }

            if (response.status === 404) {
                if (!body.type) { body.type = 'not_found'; }
                if (!body.title) { body.title = 'Not found.'; }
            }

            if (response.status >= 400) {
                if (!body.uri) { body.uri = req.uri; }
                if (!body.method) { body.method = req.method; }
            }

            if (!body.type) {
                body.type = 'unknown_error';
            }

            // Prefix error base URL
            // XXX: make the prefix configurable
            body.type = 'https://restbase.org/errors/' + body.type;
            response.body = body;
        }

        if (response.body) {
            body = response.body;
            // Convert to a buffer
            if (!Buffer.isBuffer(body)) {
                if (typeof body === 'object') {
                    if (!response.headers['content-type']) {
                        response.headers['content-type'] = 'application/json';
                    }
                    body = new Buffer(JSON.stringify(body));
                } else  {
                    body = new Buffer(body);
                }
            }
            response.headers.connection = 'close';
            var cType = response.headers['content-type'];
            if (/\bgzip\b/.test(req.headers['accept-encoding'])
                    && /^application\/json\b|^text\//.test(cType)) {
                if (response.headers['content-length']) {
                   delete response.headers['content-length'];
                }
                response.headers['content-encoding'] = 'gzip';
                resp.writeHead(response.status, '', response.headers);
                var zStream = zlib.createGzip({ level: 3 });
                zStream.pipe(resp);
                zStream.end(body);
            } else {
                response.headers['content-length'] = body.length;
                resp.writeHead(response.status, '', response.headers);
                resp.end(body);
            }
        } else {
            if (response.headers['content-length']) {
                opts.log('warn/response/content-length', {
                    req: req,
                    res: response,
                    reason: new Error('Invalid content-length')
                });
                delete response.headers['content-length'];
            }
            resp.writeHead(response.status, '', response.headers);
            resp.end();
        }
    } else {
        opts.log('error/request', {
            req: req,
            msg: "No content returned"
        });

        if (!response) { response = {}; }
        if (!response.headers) { response.headers = {}; }

        response.headers['content-type'] = 'application/problem+json';
        resp.writeHead(response.status || 500, '', response.headers);
        resp.end(JSON.stringify({
            type: 'https://restbase.org/errors/no_content',
            title: 'RESTBase error: No content returned by backend.',
            uri: req.url,
            method: req.method
        }));
    }
}

// Handle a single request
function handleRequest (opts, req, resp) {
    // set the request ID early on for external requests
    req.headers = req.headers || {};
    req.headers['x-request-id'] = req.headers['x-request-id'] || rbUtil.generateRequestId();

    var reqOpts = {
        conf: opts.conf,
        logger: opts.logger.child({
            req: {
                method: req.method.toLowerCase(),
                uri: req.url
            },
            request_id: req.headers['x-request-id']
        }),
        log: null,
        reqId: req.headers['x-request-id'],
        metrics: opts.metrics
    };
    reqOpts.log = reqOpts.logger.log.bind(reqOpts.logger);

    // Create a new, clean request object
    var urlData = rbUtil.parseURL(req.url);

    var newReq = {
        uri: new URI(urlData.pathname),
        query: urlData.query,
        method: req.method.toLowerCase(),
        headers: req.headers,
    };

    // Start off by parsing any POST data with BusBoy
    return rbUtil.parsePOST(req)

    .catch(function(e) {
        throw new rbUtil.HTTPError({
            status: 400,
            body: {
                type: 'invalid_request'
            }
        });
    })

    // Then process the request
    .then(function(body) {

        if (body && /^application\/json/i.test(req.headers['content-type'])) {
            try {
                body = JSON.parse(body.toString());
            } catch (e) {
                reqOpts.log('error/request/json-parsing', e);
            }
        }

        newReq.body = body;

        // Quick hack to set up general CORS
        if (newReq.method === 'options') {
            return P.resolve({
                status: 200
            });
        } else {
            return opts.restbase.request(newReq);
        }
    })

    // And finally handle the response
    .then(function(result) {
        return handleResponse(reqOpts, newReq, resp, result);
    })
    .catch (function(e) {
        if (!e || e.name !== 'HTTPError') {
            var originalError = e;
            var stack = e && e.stack;
            e = new rbUtil.HTTPError({
                status: 500,
                body: {
                    type: 'internal_error',
                    description: e + '',
                    // Probably better to keep this private for now
                    //stack: e.stack
                }
            });
            // Log this internally
            e.stack = stack;
            e.innerError = originalError;
        }
        if (!e.status) {
            e.status = 500;
        }
        return handleResponse(reqOpts, newReq, resp, e);
    });
}

function setupConfigDefaults(conf) {
    if (!conf) { conf = {}; }
    if (!conf.logging) { conf.logging = {}; }
    if (!conf.logging.name) { conf.logging.name = 'restbase'; }
    if (!conf.logging.level) { conf.logging.level = 'warn'; }
    return conf;
}

// Main app setup
function main(options) {
    var conf = setupConfigDefaults(options.config);
    // Set up the global options object with a logger
    var opts = {
        conf: conf,
        logger: options.logger,
        log: options.logger.log.bind(options.logger),
        metrics: options.metrics
    };

    opts.router = new Router(opts);
    opts.restbase = new Restbase(opts);
    // Use a child restbase instance to sidestep the security protection for
    // direct requests to /sys
    var childRestBase = opts.restbase.makeChild({uri:'#internal-startup'});
    // Main app startup happens during async spec loading:
    return opts.router.loadSpec(conf.spec, childRestBase)
    .then(function(router) {
        var server = http.createServer(handleRequest.bind(null, opts));
        // Use a large listen queue
        // Also, echo 1024 | sudo tee /proc/sys/net/core/somaxconn
        // (from 128 default)
        var port = conf.port || 7231;
        // Apply some back-pressure.
        server.maxConnections = 500;
        server.listen(port);
        opts.log('info', 'listening on port ' + port);
        return server;
    })
    .catch(function(e) {
        opts.log('fatal/startup', {
            status: e.status,
            err: e,
            stack: e.body && e.body.stack || e.stack
        });
        // Delay exiting to avoid heavy restart load & let the logger finish its business
        setTimeout(function() {
            process.exit(1);
        }, 2000);
    });
}

if (module.parent === null) {
    main();
} else {
    module.exports = main;
}
