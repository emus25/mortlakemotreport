/* Serves the app on this computer with the real Code.gs answering at /exec,
 * running on the fake Google from fake-google.js. index.html is served with
 * SCRIPT_URL pointed at /exec; the file on disk is not changed.
 *
 *   node tests/serve.js            then open http://localhost:8790  (password: pw)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadBackend } = require('./fake-google');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };

function start(port, backendOptions) {
  backendOptions = backendOptions || {};
  const backend = loadBackend(backendOptions);
  // Tests can make the next requests for an action fail, to check what Paul sees:
  // failures: Google never gets the request; lostReplies: Google does the
  // work but the reply never reaches the page.
  const failures = {};
  const lostReplies = {};
  // Every request the page makes, in order, so tests can count round trips.
  const log = [];
  // Real Apps Script takes a second or more per request; tests can add that.
  const latencyMs = backendOptions.latencyMs || 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/exec') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let action = '';
        try { action = JSON.parse(body).action; } catch (e) {}
        log.push(action);
        setTimeout(() => answer(action), latencyMs);
      });
      const answer = (action) => {
        if (failures[action] > 0) {
          failures[action]--;
          res.writeHead(502, { 'Content-Type': 'text/html' });   // what a Google outage looks like to the page
          res.end('<html>Bad gateway</html>');
          return;
        }
        const out = backend.sandbox.doPost({ postData: { contents: body } });
        if (lostReplies[action] > 0) {
          lostReplies[action]--;
          res.writeHead(502, { 'Content-Type': 'text/html' });
          res.end('<html>Bad gateway</html>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(out.getContent());
      };
      return;
    }
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    let data = fs.readFileSync(file);
    if (path.basename(file) === 'index.html') {
      data = Buffer.from(data.toString('utf8').replace(/var SCRIPT_URL = '[^']*';/, "var SCRIPT_URL = '/exec';"));
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, backend, failures, lostReplies, log, url: 'http://localhost:' + server.address().port }));
  });
}

module.exports = { start };

if (require.main === module) {
  let n = 0;
  start(8790, {
    claude: (kind) => {
      n++;
      return { status: 'success', result: kind === 'cert'
        ? { is_calibration_certificate: true, equipment_name: 'Roller Brake Tester', serial_number: '80780205', next_due: '31/10/2027', rotation: 0, confidence: 'high' }
        : { category: 'mot_vehicle_paperwork', document_type: ['vt20_certificate', 'inspection_sheet', 'emissions_test'][n % 3],
            registration: 'AB' + (10 + Math.floor(n / 3)) + 'CDE', tester_name: 'T STONE', rotation: 0, confidence: 'high' } };
    }
  }).then((s) => console.log('App with a pretend Google running at ' + s.url + '  (password: pw)'));
}
