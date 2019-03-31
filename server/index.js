'use strict';

const config = require('config');
const log = require('./lib/log');
const appBuilder = require('./app-builder');
const translate = require('./lib/translate');
const http = require('http');
const triggers = require('./services/triggers');
const gdprCleanup = require('./services/gdpr-cleanup');
const importer = require('./lib/importer');
const feedcheck = require('./lib/feedcheck');
const verpServer = require('./services/verp-server');
const testServer = require('./services/test-server');
const postfixBounceServer = require('./services/postfix-bounce-server');
const tzupdate = require('./services/tzupdate');
const dbcheck = require('./lib/dbcheck');
const senders = require('./lib/senders');
const reportProcessor = require('./lib/report-processor');
const executor = require('./lib/executor');
const privilegeHelpers = require('./lib/privilege-helpers');
const knex = require('./lib/knex');
const shares = require('./models/shares');
const { AppType } = require('../shared/app');
const builtinZoneMta = require('./lib/builtin-zone-mta');

const { uploadedFilesDir } = require('./lib/file-helpers');
const { filesDir } = require('./models/files');

const trustedPort = config.www.trustedPort;
const sandboxPort = config.www.sandboxPort;
const publicPort = config.www.publicPort;
const host = config.www.host;

if (config.title) {
    process.title = config.title;
}


function startHTTPServer(appType, appName, port, callback) {
    const app = appBuilder.createApp(appType);
    app.set('port', port);

    const server = http.createServer(app);

    server.on('error', err => {
        if (err.syscall !== 'listen') {
            throw err;
        }

        const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;

        // handle specific listen errors with friendly messages
        switch (err.code) {
            case 'EACCES':
                log.error('Express', '%s requires elevated privileges', bind);
                return process.exit(1);
            case 'EADDRINUSE':
                log.error('Express', '%s is already in use', bind);
                return process.exit(1);
            default:
                throw err;
        }
    });

    server.on('listening', () => {
        const addr = server.address();
        const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
        log.info('Express', 'WWW server [%s] listening on %s', appName, bind);
    });

    server.listen({port, host}, callback);
}

// ---------------------------------------------------------------------------------------
// Start the whole circus here
// ---------------------------------------------------------------------------------------
dbcheck(err => { // Check if database needs upgrading before starting the server - legacy migration first
    if (err) {
        log.error('DB', err.message || err);
        return process.exit(1);
    }

    knex.migrate.latest() // And now the current migration with Knex

    .then(() => shares.regenerateRoleNamesTable())
    .then(() => shares.rebuildPermissions())

/* Simplified startup without services - only for debugging the UI and models
    .then(() =>
        startHTTPServer(AppType.TRUSTED, 'trusted', trustedPort, () =>
            startHTTPServer(AppType.SANDBOXED, 'sandbox', sandboxPort, () =>
                startHTTPServer(AppType.PUBLIC, 'public', publicPort, async () => {

                    await privilegeHelpers.ensureMailtrainDir(uploadedFilesDir);

                    privilegeHelpers.dropRootPrivileges();

                    tzupdate.start();

                    log.info('Service', 'All services started');
                    appBuilder.setReady();
                })
            )
        )
    );
*/

    .then(() =>
        executor.spawn(() => 
            testServer(() => 
                verpServer(() =>
                    builtinZoneMta.spawn(() =>
                        startHTTPServer(AppType.TRUSTED, 'trusted', trustedPort, () =>
                            startHTTPServer(AppType.SANDBOXED, 'sandbox', sandboxPort, () =>
                                startHTTPServer(AppType.PUBLIC, 'public', publicPort, async () => {

                                    await privilegeHelpers.ensureMailtrainDir(filesDir);
                                    await privilegeHelpers.ensureMailtrainDir(uploadedFilesDir);

                                    privilegeHelpers.dropRootPrivileges();

                                    tzupdate.start();

                                    importer.spawn(() =>
                                        feedcheck.spawn(() =>
                                            senders.spawn(() => {
                                                triggers.start();
                                                gdprCleanup.start();

                                                postfixBounceServer(async () => {
                                                    await reportProcessor.init();
                                                    log.info('Service', 'All services started');
                                                    appBuilder.setReady();
                                                });
                                            })
                                        )
                                    );
                                })
                            )
                        )
                    )
                )
            )
        )
    );
});


