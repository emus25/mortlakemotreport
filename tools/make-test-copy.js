/* Makes test.html: a copy of index.html that talks to the TEST back office
 * (its own Apps Script project and its own "Mortlake Garage Records (TEST)"
 * folder) and shows a "TEST COPY" banner on every screen.
 *
 *   node tools/make-test-copy.js https://script.google.com/macros/s/XXXX/exec
 *
 * test.html sits next to index.html so it uses the same assets folder. */
'use strict';
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || '')) {
  console.error('Give the TEST back office web app URL (https://script.google.com/macros/s/…/exec).');
  process.exit(1);
}
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const before = html;
html = html.replace(/var SCRIPT_URL = '[^']*';/, "var SCRIPT_URL = '" + url + "';");
html = html.replace('var IS_TEST_COPY = false;', 'var IS_TEST_COPY = true;');
// Its own saved password and cache, so the test copy and the real app never
// share anything in the browser either.
html = html.replace("var PW_KEY = 'mortlake_report_password';", "var PW_KEY = 'mortlake_report_password_TEST';");
html = html.replace("var STORE_KEY = 'mortlake_report_v1';", "var STORE_KEY = 'mortlake_report_v1_TEST';");
html = html.replace("var MOVED_KEY = 'mortlake_testlog_moved';", "var MOVED_KEY = 'mortlake_testlog_moved_TEST';");
if (html === before || (html.match(/_TEST'/g) || []).length !== 3 || html.indexOf('IS_TEST_COPY = true') < 0) {
  console.error('index.html did not look as expected; test.html was not written.');
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'test.html'), html);
console.log('Wrote test.html pointing at ' + url);
