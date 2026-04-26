(function () {
  'use strict';

  var script = document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  var agentId = script.getAttribute('data-agent') || 'dev';
  var baseUrl = script.src ? new URL(script.src).origin : '';

  // Avoid double-init
  if (window.__leaddesk_loaded) return;
  window.__leaddesk_loaded = true;

  // --- Styles ---
  var style = document.createElement('style');
  style.textContent = [
    '#ld-bubble{',
      'position:fixed;bottom:24px;right:24px;z-index:2147483646;',
      'width:56px;height:56px;border-radius:50%;',
      'background:#7c3aed;',
      'box-shadow:0 4px 16px rgba(124,58,237,.5);',
      'display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;border:none;transition:transform .2s,box-shadow .2s;',
    '}',
    '#ld-bubble:hover{transform:scale(1.08);box-shadow:0 6px 22px rgba(124,58,237,.6);}',
    '#ld-bubble svg{fill:#fff;width:26px;height:26px;transition:opacity .2s;}',
    '#ld-frame-wrap{',
      'position:fixed;bottom:92px;right:24px;z-index:2147483645;',
      'width:380px;height:580px;max-height:calc(100vh - 110px);',
      'border-radius:16px;overflow:hidden;',
      'box-shadow:0 8px 40px rgba(0,0,0,.18);',
      'transform:scale(.92) translateY(12px);opacity:0;',
      'transform-origin:bottom right;',
      'transition:transform .22s cubic-bezier(.34,1.56,.64,1),opacity .18s;',
      'pointer-events:none;',
    '}',
    '#ld-frame-wrap.ld-open{transform:scale(1) translateY(0);opacity:1;pointer-events:auto;}',
    '#ld-frame{width:100%;height:100%;border:none;display:block;}',
    '@media(max-width:480px){',
      '#ld-frame-wrap{width:calc(100vw - 16px);right:8px;bottom:80px;height:calc(100vh - 100px);border-radius:12px;}',
    '}',
  ].join('');
  document.head.appendChild(style);

  // --- Bubble ---
  var bubble = document.createElement('button');
  bubble.id = 'ld-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>';
  document.body.appendChild(bubble);

  // --- Frame wrapper ---
  var wrap = document.createElement('div');
  wrap.id = 'ld-frame-wrap';

  var iframe = document.createElement('iframe');
  iframe.id = 'ld-frame';
  iframe.src = baseUrl + '/chat-frame?agentId=' + encodeURIComponent(agentId);
  iframe.title = 'LeadDesk Chat';
  iframe.setAttribute('allow', '');
  wrap.appendChild(iframe);
  document.body.appendChild(wrap);

  // --- Toggle ---
  var open = false;

  function openChat() {
    open = true;
    wrap.classList.add('ld-open');
    bubble.setAttribute('aria-label', 'Close chat');
    bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  }

  function closeChat() {
    open = false;
    wrap.classList.remove('ld-open');
    bubble.setAttribute('aria-label', 'Open chat');
    bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>';
  }

  bubble.addEventListener('click', function () {
    if (open) closeChat(); else openChat();
  });

  // Close via postMessage from iframe
  window.addEventListener('message', function (e) {
    if (e.data === 'ld-close') closeChat();
  });

})();
