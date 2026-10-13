/* Makes realistic-looking (but clearly SAMPLE) MOT paperwork as images and a
   PDF, for a full test with made-up figures. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
if (!OUT) { console.error('Usage: node tests/live-docs.js <folder>'); process.exit(1); }
const css = `body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#fbfaf6;color:#111}
.pg{width:794px;height:1123px;padding:48px 56px;box-sizing:border-box;position:relative}
h1{font-size:22px;margin:0 0 4px} .sub{font-size:12px;color:#444;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0} td,th{border:1px solid #333;padding:6px 8px;text-align:left}
.big{font-size:26px;font-weight:bold;letter-spacing:2px} .stamp{position:absolute;right:60px;top:60px;border:3px solid #a00;color:#a00;padding:6px 12px;font-weight:bold;transform:rotate(8deg)}
.hand{font-family:'Comic Sans MS',cursive;color:#1a3ea8;font-size:20px;transform:rotate(-4deg);margin-top:30px}
.sample{position:absolute;bottom:30px;left:56px;color:#999;font-size:11px}`;
const site = 'Mortlake Station Garage · VTS 22453 · 29 Sheen Lane, Mortlake SW14 8HY';
function vt20(v) { return `<div class="pg"><div class="stamp">PASS</div><h1>MOT test certificate (VT20)</h1><div class="sub">Driver and Vehicle Standards Agency · ${site}</div>
<table><tr><th>Registration</th><td class="big">${v.reg}</td></tr><tr><th>Make / model</th><td>${v.make}</td></tr><tr><th>Fuel</th><td>${v.fuel}</td></tr>
<tr><th>Date of test</th><td>${v.date}</td></tr><tr><th>Odometer</th><td>${v.miles} miles</td></tr><tr><th>Tested by</th><td>${v.tester}</td></tr><tr><th>Test number</th><td>${v.num}</td></tr><tr><th>Expiry</th><td>${v.expiry}</td></tr></table>
<p>Advisories: Nearside front tyre worn close to legal limit (5.2.3 (e))</p>${v.qc ? '<div class="hand">QC check — PK ' + v.date + '</div>' : ''}<div class="sample">SAMPLE DOCUMENT FOR SOFTWARE TESTING — NOT A REAL CERTIFICATE</div></div>`; }
function sheet(v) { return `<div class="pg"><h1>MOT inspection checklist</h1><div class="sub">${site}</div>
<table><tr><th>Vehicle registration</th><td class="big">${v.reg}</td><th>Tester</th><td>${v.tester}</td></tr><tr><th>Date</th><td>${v.date}</td><th>Make</th><td>${v.make}</td></tr></table>
<table><tr><th>Brake test (roller)</th><th>Nearside</th><th>Offside</th><th>Efficiency</th></tr><tr><td>Service brake axle 1</td><td>212 kgf</td><td>220 kgf</td><td rowspan="2">${v.eff}%</td></tr><tr><td>Service brake axle 2</td><td>140 kgf</td><td>138 kgf</td></tr><tr><td>Parking brake</td><td>118 kgf</td><td>121 kgf</td><td>24%</td></tr></table>
<table>${['Lamps, reflectors and electrical','Steering','Suspension','Tyres and wheels','Seat belts','Body, structure','Visibility','Exhaust, fuel and emissions'].map(x=>`<tr><td>${x}</td><td>✔ Pass</td></tr>`).join('')}</table>
<div class="sample">SAMPLE DOCUMENT FOR SOFTWARE TESTING</div></div>`; }
function emis(v) { return `<div class="pg" style="width:600px;height:900px;font-family:Courier New,monospace"><h1 style="font-family:Courier New">EXHAUST GAS ANALYSER</h1><div class="sub">V-Tech Opus Combi  S/N 11210011</div>
<pre style="font-size:15px">VTS NO: 22453
REG:    ${v.reg}
DATE:   ${v.date}
FUEL:   ${v.fuel.toUpperCase()}

FAST IDLE  RPM 2510
  CO   0.02 %vol   LIMIT 0.20
  HC   12 ppm      LIMIT 200
  LAMBDA 1.001     LIMIT 0.97-1.03
NATURAL IDLE RPM 780
  CO   0.01 %vol   LIMIT 0.30

RESULT:  PASS
TESTER:  ${v.tester}</pre><div class="sample">SAMPLE PRINTOUT FOR SOFTWARE TESTING</div></div>`; }
function cert() { return `<div class="pg"><h1>Certificate of Calibration</h1><div class="sub">Brake Test Services Ltd (SAMPLE) · UKAS-style calibration report</div>
<table><tr><th>Customer</th><td>Mortlake Station Garage, VTS 22453</td></tr><tr><th>Equipment</th><td>Roller Brake Tester</td></tr><tr><th>Make / model</th><td>Hofmann Brekon 120</td></tr>
<tr><th>Serial number</th><td class="big">80780205</td></tr><tr><th>Certificate no.</th><td>BTS-2026-04417</td></tr><tr><th>Date of calibration</th><td>14/05/2026</td></tr><tr><th>Next calibration due</th><td>14/05/2027</td></tr><tr><th>Engineer</th><td>D. Marsh</td></tr></table>
<p>Load cell readings within ±2% across the range. Equipment found satisfactory.</p><div class="sample">SAMPLE CERTIFICATE FOR SOFTWARE TESTING</div></div>`; }
const cars = [
  { reg: 'LB22FLC', make: 'FORD FOCUS ST-LINE', fuel: 'Petrol', date: '06/05/2026', miles: '41,220', tester: 'T STONE', num: '5512 0981 3301', expiry: '05/05/2027', eff: 64, qc: true },
  { reg: 'WR19KXA', make: 'VOLKSWAGEN GOLF TDI', fuel: 'Diesel', date: '12/05/2026', miles: '78,904', tester: 'P KHAN', num: '5512 1042 7720', expiry: '11/05/2027', eff: 58 },
  { reg: 'GN71TVZ', make: 'TESLA MODEL 3', fuel: 'Electric', date: '20/05/2026', miles: '22,310', tester: 'R DAVIS', num: '5512 1199 0264', expiry: '19/05/2027', eff: 71 }
];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 794, height: 1123 } });
  async function shot(html, name, w, h, rotate) {
    await p.setViewportSize({ width: w || 794, height: h || 1123 });
    await p.setContent(`<style>${css}</style>` + html);
    const f = path.join(OUT, name);
    await p.screenshot({ path: f, type: name.endsWith('.jpg') ? 'jpeg' : 'png', quality: name.endsWith('.jpg') ? 85 : undefined });
    return f;
  }
  const made = [];
  made.push(await shot(vt20(cars[0]), 'LB22FLC-vt20.jpg'));
  made.push(await shot(sheet(cars[0]), 'LB22FLC-inspection.jpg'));
  made.push(await shot(emis(cars[0]), 'LB22FLC-emissions.jpg', 600, 900));
  made.push(await shot(vt20(cars[1]), 'WR19KXA-vt20.jpg'));
  made.push(await shot(emis(cars[1]), 'WR19KXA-emissions.jpg', 600, 900));
  // The Golf's inspection sheet was fed through the scanner sideways.
  await p.setViewportSize({ width: 1123, height: 794 });
  await p.setContent(`<style>${css} body{width:1123px;height:794px;overflow:hidden}</style><div style="transform:rotate(90deg) translate(0,-1123px);transform-origin:top left;width:794px">${sheet(cars[1])}</div>`);
  await p.screenshot({ path: path.join(OUT, 'WR19KXA-inspection-sideways.jpg'), type: 'jpeg', quality: 85 }); made.push('WR19KXA-inspection-sideways.jpg');
  // The Tesla's two pages arrive as one scanned PDF.
  await p.setViewportSize({ width: 794, height: 1123 });
  await p.setContent(`<style>${css} .pg{page-break-after:always}</style>` + vt20(cars[2]) + sheet(cars[2]));
  await p.pdf({ path: path.join(OUT, 'GN71TVZ-scan.pdf'), width: '794px', height: '1123px', printBackground: true }); made.push('GN71TVZ-scan.pdf');
  made.push(await shot(cert(), 'calibration-cert-brake-tester.jpg'));
  console.log(made.map(f => path.basename(f)).join('\n'));
  await b.close();
})();
