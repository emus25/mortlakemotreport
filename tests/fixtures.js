/* Test files that look like the real thing: DVSA exports built as genuine
 * .xlsx files with the same layout the app's readers expect, and scanned
 * pages as genuine PNG images. All figures and names are made up. */
'use strict';
const path = require('path');
const zlib = require('zlib');
const XLSX = require(path.join(__dirname, '..', 'assets', 'lib', 'xlsx.full.min.js'));

function xlsxBuffer(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Excel date serial for a day in a given month (time of day as a fraction).
function serial(y, m, d, h) {
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000 + (h || 9) / 24;
}

/* A test log for the given month: one row per test. */
function testLog(year, month, count) {
  const rows = [['Registration', 'Result', 'Make', 'User ID', 'Test Type', 'Test Duration', 'Test Date/Time']];
  const testers = ['TSTONE', 'PKHAN', 'RDAVIS'];
  for (let i = 0; i < count; i++) {
    rows.push(['AB' + (10 + (i % 80)) + 'CDE', i % 5 ? 'PASSED' : 'FAILED', ['FORD', 'VW', 'BMW'][i % 3],
               testers[i % 3], i % 9 ? 'Normal Test' : 'Re-Test', (35 + (i * 7) % 30) / 1440,
               serial(year, month, 1 + (i % 28), 9 + (i % 8))]);
  }
  return xlsxBuffer(rows);
}

/* A Test Quality Information export for a period such as "Sep-26". */
function testQuality(period) {
  return xlsxBuffer([
    ['Mortlake Station Garage'],
    ['V22453'],
    [period],
    [],
    ['', 'T STONE', 'P KHAN', 'R DAVIS', 'Site average', 'National average'],
    ['', 'TSTONE', 'PKHAN', 'RDAVIS', '', ''],
    ['Tests done', 80, 70, 60, 210, 160],
    ['Average vehicle age', 9.1, 8.7, 10.2, 9.3, 9.8],
    ['Average test time', 48, 52, 45, 48, 51],
    ['Tests failed', 0.22, 0.25, 0.30, 0.25, 0.28],
    ['Failures by category'],
    ['Brakes', '', '', '', 0.05, 0.06],
    ['Lamps', '', '', '', 0.08, 0.07]
  ]);
}

/* A real PNG of the given size and colour. Each colour gives different file
   bytes, so each counts as a different scan. */
function png(width, height, rgb) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { testLog, testQuality, png, xlsxBuffer };
