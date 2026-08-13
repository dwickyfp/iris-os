const SANDBOX_PROXY = `<!doctype html><html><body style="margin:0"><script>
const parentOrigin = location.origin;
let appFrame;
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'}, parentOrigin);
window.addEventListener('message', event => {
  if (event.origin !== parentOrigin) return;
  const message = event.data;
  if (message?.method === 'ui/notifications/sandbox-resource-ready') {
    const params = message.params || {};
    appFrame = document.createElement('iframe');
    appFrame.setAttribute('sandbox', params.sandbox || 'allow-scripts allow-forms');
    appFrame.setAttribute('allow', params.allow || '');
    appFrame.style.cssText = 'border:0;width:100vw;height:100vh';
    appFrame.srcdoc = params.html || '';
    document.body.replaceChildren(appFrame);
    return;
  }
  appFrame?.contentWindow?.postMessage(message, '*');
});
window.addEventListener('message', event => {
  if (event.source === appFrame?.contentWindow) parent.postMessage(event.data, parentOrigin);
});
</script></body></html>`;

export function GET() {
  return new Response(SANDBOX_PROXY, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self';",
    },
  });
}
