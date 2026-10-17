/* Which way up? Real Claude, through the REAL TEST back office: one sample
 * sheet turned all four ways, each read 3 times. The report must turn every
 * one of them upright, never upside down.
 *
 *   TEST_PASSWORD=… node tests/live-rotation.js /tmp/docs
 */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const D = process.argv[2], PASSWORD = process.env.TEST_PASSWORD;
const html = fs.readFileSync(path.join(__dirname, '..', 'test.html'), 'utf8');
const URL = html.match(/var SCRIPT_URL = '([^']+)'/)[1];
async function post(body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
      return JSON.parse(await r.text());
    } catch (e) { /* ask again */ }
  }
  return { status: 'noreply' };
}
(async () => {
  const token = (await post({ action: 'checkDashboardPassword', password: PASSWORD })).token;
  // Turn an upright sheet each way in a browser canvas: [how it's turned, where its title ends up, rotation needed].
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const src = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(D, 'LB22FLC-inspection.jpg')).toString('base64');
  const turns = [[0, 'top', 0], [90, 'right', 270], [180, 'bottom', 180], [270, 'left', 90]];
  const images = await page.evaluate(async ({ src, turns }) => {
    const img = new Image(); img.src = src; await img.decode();
    return turns.map(([deg]) => {
      const q = deg === 90 || deg === 270, c = document.createElement('canvas');
      c.width = q ? img.height : img.width; c.height = q ? img.width : img.height;
      const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180);
      x.drawImage(img, -img.width / 2, -img.height / 2);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
  }, { src, turns });
  await browser.close();
  let wrong = 0, n = 0;
  for (let t = 0; t < turns.length; t++) {
    const [deg, top, need] = turns[t];
    const got = [];
    for (let k = 0; k < 3; k++) {
      const r = await post({ action: 'analyzeQcPage', token, imageBase64: images[t], mimeType: 'image/jpeg' });
      const rot = r.result ? r.result.rotation : 'error: ' + (r.message || r.status);
      got.push(rot + (r.result ? ' (' + r.result.document_top + ', ' + r.result.registration + ')' : ''));
      n++; if (rot !== need) wrong++;
    }
    console.log((got.every(g => g.startsWith(need + ' ')) ? '✅' : '❌') + ' turned ' + deg + '° clockwise (title at the ' + top +
                '): needs ' + need + '° — got ' + got.join(', '));
  }
  console.log(wrong ? 'WRONG ' + wrong + ' of ' + n : 'ALL ' + n + ' RIGHT');
})();
