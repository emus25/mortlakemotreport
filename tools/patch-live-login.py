# Applies the v20 secure login to the LIVE page (index.html on main) only.
# Usage: python3 tools/patch-live-login.py path/to/live/index.html
# Delete this file once this branch goes live (it replaces the live page).
import sys
p=sys.argv[1]; s=open(p).read()
def rep(a,b,n=1):
    global s
    assert s.count(a)==n, (a[:90], s.count(a))
    s=s.replace(a,b)
a=s.index("  var PW_KEY = 'mortlake_report_password';")
m=s.index("    // No backend deployed yet, so skip the lock screen for local review.")
b=s.index("  })();\n", m)+len("  })();\n")
new = r"""  var PASS_KEY = 'mortlake_report_pass';

  /* ── Logging in: secure, and a correct password never fails ──
     (Ediz, 16 Oct 2026.)
     - The password is checked once. Google then gives this computer a
       "pass" that works for 30 days; the app keeps the pass, never the
       password. Every request to Google is checked against the pass.
     - If Google is slow to wake up, the app keeps asking for up to two
       minutes rather than giving up. A slow answer still counts.
     - The box doesn't auto-capitalise or autocorrect, a stray space at the
       end is ignored, and "Caps Lock is on" is shown when it is.
     - After 5 wrong passwords Google pauses logging in for 15 minutes;
       computers that already have a pass carry on.
     Only a real "wrong" answer from Google may say "Incorrect password". A
     Google that can't be reached says NOTHING about the password. */
  var LOGIN_ATTEMPT_MS = 40000;
  var LOGIN_GIVE_UP_MS = 120000;
  var NO_REPLY_MSG = 'Couldn’t reach Google for two minutes — this is not a password problem. ' +
                     'Check the internet connection and press Unlock again.';

  // Earlier versions kept the password itself in the browser. Not any more.
  try { localStorage.removeItem('mortlake_report_password'); } catch (e) {}

  function readPass_() {
    try {
      var p = JSON.parse(localStorage.getItem(PASS_KEY));
      return p && p.token && p.expires > Date.now() ? p : null;
    } catch (e) { return null; }
  }
  function getPass_() { var p = readPass_(); return p ? p.token : ''; }
  function forgetPass_() { try { localStorage.removeItem(PASS_KEY); } catch (e) {} }

  function askPasswordOnce_(pw) {
    return fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'checkDashboardPassword', password: pw }) })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) {}
        if (data && data.status === 'success' && data.token) return { result: 'ok', pass: { token: data.token, expires: data.expires } };
        if (data && data.status === 'fail') return { result: 'wrong' };
        if (data && data.status === 'paused') return { result: 'paused', message: data.message };
        return { result: 'noreply' };
      })
      .catch(function () { return { result: 'noreply' }; });
  }

  function verifyPassword(pw, onResult, onWait) {
    if (!SCRIPT_URL) { onResult('noreply', 'Backend not deployed yet.'); return; }
    var started = Date.now(), done = false, delay = 1000, nextTry = null;
    var ticker = onWait ? setInterval(function () { onWait(Math.round((Date.now() - started) / 1000)); }, 1000) : null;
    var giveUp = setTimeout(function () { finish('noreply', NO_REPLY_MSG); }, LOGIN_GIVE_UP_MS);
    function finish(result, msg, pass) {
      if (done) return;
      done = true;
      clearInterval(ticker); clearTimeout(giveUp); clearTimeout(nextTry);
      onResult(result, msg, pass);
    }
    function ask() {
      return askPasswordOnce_(pw).then(function (a) {
        if (a.result === 'wrong' && pw.trim() !== pw && pw.trim()) return askPasswordOnce_(pw.trim());
        return a;
      });
    }
    function again(wait) { clearTimeout(nextTry); nextTry = setTimeout(attempt, wait); }
    function attempt() {
      if (done) return;
      again(LOGIN_ATTEMPT_MS);
      ask().then(function (a) {
        if (a.result === 'ok') return finish('ok', '', a.pass);
        if (a.result === 'wrong') return finish('wrong', 'Incorrect password.');
        if (a.result === 'paused') return finish('paused', a.message);
        again(delay);
        delay = Math.min(delay * 2, 8000);
      });
    }
    attempt();
  }

  function lockApp(msg) {
    forgetPass_();
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    var err = document.getElementById('lockError');
    if (msg) { err.textContent = msg; err.classList.add('show'); } else { err.classList.remove('show'); }
    document.getElementById('lockPasswordInput').value = '';
  }

  function unlockApp() {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('appRoot').style.display = 'block';
    // Pull the server copy first so a new laptop starts with the real history.
    if (typeof syncDown_ === 'function') syncDown_();
  }

  // Google refused the pass: 30 days are up, or the password was changed.
  var passRefused_ = false;
  function passRefused() {
    if (passRefused_) return;
    passRefused_ = true;
    forgetPass_();
    try { sessionStorage.setItem('mortlake_pass_ended', '1'); } catch (e) {}
    location.reload();
  }

  function logOut() {
    var token = getPass_();
    forgetPass_();
    if (token && SCRIPT_URL) {
      fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'logout', token: token }) }).catch(function () {});
    }
    location.reload();
  }

  function submitLockScreen() {
    var pw = document.getElementById('lockPasswordInput').value;
    var btn = document.getElementById('lockSubmitBtn');
    var errEl = document.getElementById('lockError');
    if (btn.disabled || !pw) return;
    errEl.textContent = '';
    errEl.classList.remove('show');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    verifyPassword(pw, function (result, msg, pass) {
      btn.disabled = false;
      btn.textContent = 'Unlock';
      if (result === 'ok') {
        try { localStorage.setItem(PASS_KEY, JSON.stringify(pass)); } catch (e) {}
        document.getElementById('lockPasswordInput').value = '';
        unlockApp();
      } else {
        errEl.textContent = msg;
        errEl.classList.add('show');
      }
    }, function (secs) {
      if (secs >= 4) btn.textContent = 'Waking Google up… ' + secs + 's';
    });
  }

  (function () {
    var input = document.getElementById('lockPasswordInput');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitLockScreen();
    });
    function capsHint(e) {
      var hint = document.getElementById('lockCaps');
      if (hint && e.getModifierState) hint.hidden = !e.getModifierState('CapsLock');
    }
    input.addEventListener('keyup', capsHint);
    input.addEventListener('keydown', capsHint);
  })();

  (function () {
    // No backend deployed yet, so skip the lock screen for local review.
    if (!SCRIPT_URL) { setTimeout(unlockApp, 0); return; }
    var ended = false;
    try { ended = !!sessionStorage.getItem('mortlake_pass_ended'); sessionStorage.removeItem('mortlake_pass_ended'); } catch (e) {}
    if (ended) { lockApp('Please type the password again — it’s been 30 days, or the password was changed.'); return; }
    if (readPass_()) setTimeout(unlockApp, 0);
  })();
"""
s=s[:a]+new+s[b:]
rep("password: getPassword()", "token: getPass_()", 4)
rep("!getPassword()", "!getPass_()", 3)
rep("getPassword() && !syncDownDone", "getPass_() && !syncDownDone")
rep("""      .then(function (res) {
        if (res.status !== 'success') {
          // An older backend""","""      .then(function (res) {
        if (res.status === 'forbidden') { passRefused(); return; }
        if (res.status !== 'success') {
          // An older backend""")
rep("var EXPECTED_BACKEND_VERSION = 12;","var EXPECTED_BACKEND_VERSION = 20;")
rep('''    <input type="password" id="lockPasswordInput" class="lock-input" autocomplete="current-password">''','''    <input type="password" id="lockPasswordInput" class="lock-input" autocomplete="current-password"
           autocapitalize="off" autocorrect="off" spellcheck="false">
    <div class="lock-caps" id="lockCaps" hidden>Caps Lock is on</div>''')
rep("  .lock-error.show { display: block; }","  .lock-error.show { display: block; }\n  .lock-caps { font-size: 12px; color: var(--warning); margin: -6px 0 10px; }\n  .lock-caps[hidden] { display: none; }\n  .logout-btn { background: none; border: 0; padding: 4px 2px; font: inherit; font-size: 12px; color: var(--text-tertiary); cursor: pointer; text-decoration: underline; }\n  .logout-btn:hover { color: var(--text-secondary); }")
rep('''      <button class="btn btn-primary" id="generateBtn" onclick="handleGenerate()">Generate Report</button>''','''      <button class="btn btn-primary" id="generateBtn" onclick="handleGenerate()">Generate Report</button>
      <button type="button" class="logout-btn" id="logoutBtn" onclick="logOut()" title="Log this computer out">Log out</button>''')
assert 'getPassword' not in s
open(p,'w').write(s)
print('patched')
