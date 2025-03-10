const path               = require('path');
const { expect }         = require('chai');
const isCI               = require('is-ci');
const config             = require('../../config');
const { createReporter } = require('../../utils/reporter');
const testInfo           = require('./test-info');


if (config.useLocalBrowsers) {
    describe('Concurrency', function () {
        let data = '';

        function resolvePath (file) {
            return path.join(__dirname, file);
        }

        function run (browsers, concurrency, files, reporter) {
            let src = null;

            reporter = reporter || 'json';

            if (typeof files === 'string')
                src = resolvePath(files);
            else {
                src = files.map(function (file) {
                    return resolvePath(file);
                });
            }

            return testCafe
                .createRunner()
                .src(src)
                .reporter(reporter, {
                    write: function (newData) {
                        data += newData;
                    },

                    end: function (newData) {
                        data += newData;
                    },
                })
                .browsers(browsers)
                .concurrency(concurrency)
                .run();
        }

        function createConnections (count) {
            const connections = [];

            function createConnection () {
                return testCafe.createBrowserConnection();
            }

            function addConnection (connection) {
                connections.push(connection);
                return connections;
            }

            let promise = Promise.resolve();

            for (let i = 0; i < count; i++) {
                promise = promise
                    .then(createConnection)
                    .then(addConnection);
            }

            return promise;
        }

        const customReporter = createReporter({
            reportTestDone: function (name) {
                this.write('Test ' + name + ' done').newline();
            },

            reportFixtureStart: function (name) {
                this.write('Fixture ' + name + ' started').newline();
            },
        });

        const slowReporter = createReporter({
            reportTaskStart: async function () {
                await new Promise(resolve => setTimeout(() => resolve(), 100));
                this.write('Task start').newline();
            },

            reportTestStart: async function () {
                this.write('Test start').newline();
            },
        });

        beforeEach(function () {
            data = '';
        });

        afterEach(() => {
            testInfo.delete();
        });

        it('Should run tests sequentially if concurrency = 1', function () {
            return run('chrome:headless --no-sandbox', 1, './testcafe-fixtures/sequential-test.js')
                .then(() => {
                    expect(testInfo.getData()).eql(['long started', 'long finished', 'short started', 'short finished']);
                });
        });

        it('Should run tests concurrently if concurrency > 1', function () {
            return run('chrome:headless --no-sandbox', 2, './testcafe-fixtures/concurrent-test.js')
                .then(() => {
                    expect(testInfo.getData()).eql(['test started', 'test started', 'short finished', 'long finished']);
                });
        });

        it('Report TaskStart event handler should contain links to all opened browsers', async () => {
            const concurrency = 2;
            const scope       = {};
            const reporter    = createReporter({
                reportTaskStart: (_, userAgents) => {
                    scope.userAgents = userAgents;
                },
            });

            return run('chrome:headless', concurrency, './testcafe-fixtures/concurrent-test.js', reporter)
                .then(() => {
                    expect(scope.userAgents.length).eql(concurrency);
                });
        });

        // TODO: this test doesn't work on CI due to big resource demands
        if (!isCI) {
            it('Should run tests concurrently in different browser kinds', function () {
                return run(['chrome:headless --no-sandbox', 'chrome:headless --no-sandbox --user-agent="TestAgent"'], 2, './testcafe-fixtures/multibrowser-concurrent-test.js')
                    .then(() => {
                        const timelineData = testInfo.getData();

                        expect(Object.keys(timelineData).length).gt(1);

                        for (const browserTimeline of Object.values(timelineData))
                            expect(browserTimeline).eql(['test started', 'test started', 'short finished', 'long finished']);
                    });
            });
        }

        if (!config.proxyless) {
            // TODO: stabilize test on Firefox
            (config.hasBrowser('firefox') ? it.skip : it)('Should run tests concurrently with Role', function () {
                return run('chrome:headless --no-sandbox', 2, './testcafe-fixtures/role-test.js')
                    .then(() => {
                        expect(testInfo.getData()).eql(['/fixtures/concurrency/pages/first-page.html', '/fixtures/concurrency/pages/second-page.html']);
                    });
            });
        }

        it('Should report fixture start correctly if second fixture finishes before first', function () {
            return run('chrome:headless --no-sandbox', 2, ['./testcafe-fixtures/multifixture-test-a.js', './testcafe-fixtures/multifixture-test-b.js'], customReporter)
                .then(failedCount => {
                    expect(failedCount).eql(0);
                    expect(data.split('\n')).eql([
                        'Fixture Multifixture A started',
                        'Test Long test done',
                        'Fixture Multifixture B started',
                        'Test Short test done',
                        '',
                    ]);
                });
        });

        it('Should not start any test before report task start finishes', function () {
            return run('chrome:headless --no-sandbox', 2, './testcafe-fixtures/concurrent-test.js', slowReporter)
                .then(failedCount => {
                    expect(failedCount).eql(0);
                    expect(data.split('\n')).eql([
                        'Task start',
                        'Test start',
                        'Test start',
                        '',
                    ]);
                });
        });

        it('Should fail if number of remotes is not divisible by concurrency', function () {
            return createConnections(3)
                .then(function (connections) {
                    return run(connections, 2, './testcafe-fixtures/concurrent-test.js');
                })
                .then(function () {
                    throw new Error('Promise rejection expected');
                })
                .catch(function (error) {
                    expect(error.message).eql('The number of remote browsers should be divisible by the concurrency factor.');
                });
        });
    });
}

