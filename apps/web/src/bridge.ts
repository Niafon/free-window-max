// MAX Bridge (https://st.max.ru/js/max-web-app.js), as documented at dev.max.ru/docs/webapps/bridge.
type Bridge = { initData?: string; platform?: string; initDataUnsafe?: { start_param?: string }; ready?: () => void; expand?: () => void; openLink?: (url: string) => void; openMaxLink?: (url: string) => void; shareMaxContent?: (params: { text?: string; link?: string }) => unknown; BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void } };
declare global { interface Window { WebApp?: Bridge } }
export function initData() { return window.WebApp?.initData || new URLSearchParams(location.hash.slice(1)).get('WebAppData') || ''; }
export function startParam() {
  const raw = window.WebApp?.initDataUnsafe?.start_param;
  return typeof raw === 'string' ? raw : new URLSearchParams(location.hash.slice(1)).get('WebAppStartParam') || new URLSearchParams(location.search).get('startapp') || '';
}
// Inside MAX: max.ru deep links stay in the messenger (openMaxLink), other links go to the external browser (openLink).
export function openExternal(url: string) {
  if (!/^https:\/\//.test(url)) return;
  const app = window.WebApp;
  if (app && initData()) {
    if (/^https:\/\/max\.ru\//.test(url) && app.openMaxLink) { app.openMaxLink(url); return; }
    if (app.openLink) { app.openLink(url); return; }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
// Inside MAX the native "send to chat" screen; elsewhere the documented https://max.ru/:share deep link.
export function share(url: string, text: string) {
  const fallback = () => openExternal(`https://max.ru/:share?text=${encodeURIComponent(`${text}\n${url}`)}`);
  const app = window.WebApp;
  // A rejected promise usually means the user closed the share screen, so it is not retried.
  if (app?.shareMaxContent && initData()) { try { void Promise.resolve(app.shareMaxContent({ text, link: url })).catch(() => {}); } catch { fallback(); } return; }
  fallback();
}
