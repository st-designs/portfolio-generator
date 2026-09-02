// Minimal multi-page test site with SVG logo, nav, hero, sections, cookie banner
const express = require('express');
const app = express();

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40">
<circle cx="20" cy="20" r="16" fill="none" stroke="#0e3a2f" stroke-width="3"/>
<text x="14" y="26" font-family="Georgia" font-size="18" fill="#0e3a2f" font-weight="bold">A</text>
<text x="44" y="27" font-family="Georgia" font-size="20" fill="#0e3a2f">Acme</text></svg>`;

const page = (title, heroColor, body) => `<!DOCTYPE html>
<html><head><meta charset="utf8"><title>${title} — Acme Studio</title>
<meta name="theme-color" content="#0e3a2f">
<meta property="og:site_name" content="Acme Studio">
<style>
body{margin:0;font-family:Georgia,serif;color:#152420;background:#f6f4ee}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 60px;background:#fff}
nav a{margin-left:28px;color:#0e3a2f;text-decoration:none;font-family:Arial;font-size:14px}
.hero{min-height:70vh;background:${heroColor};display:flex;flex-direction:column;justify-content:center;padding:0 60px;color:#f6f4ee}
.hero h1{font-size:64px;margin:0 0 18px;max-width:700px}
.hero p{font-family:Arial;max-width:480px;line-height:1.6}
section{padding:90px 60px}
section.alt{background:#0e3a2f;color:#f6f4ee}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:40px}
.card{background:#fff;border:1px solid #ddd;border-radius:12px;padding:30px;min-height:180px}
.alt .card{background:#16493c;border-color:#1e5a4a}
footer{background:#0a271f;color:#c9d6d0;padding:60px;font-family:Arial;font-size:13px}
.cookie{position:fixed;bottom:0;left:0;right:0;background:#111;color:#fff;padding:16px 60px;display:flex;justify-content:space-between;align-items:center;font-family:Arial}
.cookie button{background:#fff;color:#111;border:0;padding:10px 22px;border-radius:6px;cursor:pointer}
@media(max-width:600px){.cards{grid-template-columns:1fr}.hero h1{font-size:36px}header{padding:14px 20px}section{padding:50px 20px}.hero{padding:0 20px}}
</style></head><body>
<header><a href="/" class="logo">${logo}</a>
<nav><a href="/about">About</a><a href="/services">Services</a><a href="/work">Work</a><a href="/login">Login</a></nav></header>
${body}
<section class="aos-init" style="opacity:0;transform:translateY(60px)"><h2>Hidden reveal section</h2>
<p style="font-family:Arial;max-width:560px">This section simulates a scroll-entrance animation that never fired (AOS-style). It must appear in captures.</p>
<div class="cards"><div class="card">Reveal one</div><div class="card">Reveal two</div><div class="card">Reveal three</div></div></section>
<footer>© Acme Studio — hello@acme.test</footer>
<div class="cookie" id="ck"><span>We use cookies.</span><button onclick="document.getElementById('ck').remove()">Accept all</button></div>
<!-- delayed newsletter modal with backdrop + scroll lock, no dismissable text -->
<div id="nl-backdrop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998"></div>
<div id="nl-modal" class="newsletter-popup" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:480px;background:#fff;z-index:9999;padding:40px;border-radius:12px;text-align:center;font-family:Arial">
  <h3 style="margin-top:0">Join our newsletter!</h3>
  <p>Get design tips every week.</p>
  <input placeholder="Your email" style="width:90%;padding:10px;margin-bottom:10px;border:1px solid #ccc;border-radius:6px">
  <br><button style="background:#0e3a2f;color:#fff;border:0;padding:12px 30px;border-radius:6px">Subscribe</button>
</div>
<!-- fake chat launcher bubble -->
<div id="chat-widget-container" style="position:fixed;right:24px;bottom:24px;width:64px;height:64px;background:#0e3a2f;border-radius:50%;z-index:99999;display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px">💬</div>
<script>
setTimeout(()=>{document.getElementById('nl-backdrop').style.display='block';
document.getElementById('nl-modal').style.display='block';
document.body.style.overflow='hidden';},1200);
</script>
</body></html>`;

const sections = (n, label) => Array.from({ length: n }, (_, i) => `
<section class="${i % 2 ? 'alt' : ''}"><h2>${label} section ${i + 1}</h2>
<p style="font-family:Arial;max-width:560px;line-height:1.7">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet.</p>
<div class="cards"><div class="card">Card one</div><div class="card">Card two</div><div class="card">Card three</div></div></section>`).join('');

app.get('/', (q, s) => s.send(page('Home', 'linear-gradient(120deg,#0e3a2f,#16493c)', `
<div class="hero"><h1>We craft digital experiences</h1><p>Acme Studio is a design practice building considered, durable brands and websites.</p></div>${sections(4, 'Home')}`)));
app.get('/about', (q, s) => s.send(page('About', '#233a67', `<div class="hero"><h1>About us</h1><p>A small team with big opinions.</p></div>${sections(3, 'About')}`)));
app.get('/services', (q, s) => s.send(page('Services', '#5b2340', `<div class="hero"><h1>Services</h1><p>Strategy, identity, web.</p></div>${sections(3, 'Services')}`)));
app.get('/work', (q, s) => s.send(page('Work', '#7a4a12', `<div class="hero"><h1>Selected work</h1><p>Recent projects.</p></div>${sections(5, 'Work')}`)));
app.get('/login', (q, s) => s.send(page('Login', '#222', `<div class="hero"><h1>Login</h1></div>`)));

app.listen(4477, () => console.log('test site on :4477'));
