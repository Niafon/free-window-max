type Bridge = { initData?: string; platform?: string; initDataUnsafe?: { start_param?: string }; ready?: () => void; expand?: () => void; openLink?: (url: string) => void; openMaxLink?: (url: string) => void; BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void } };
declare global { interface Window { WebApp?: Bridge } }
export function initData() { return window.WebApp?.initData || new URLSearchParams(location.hash.slice(1)).get('WebAppData') || ''; }
export function startParam() {
  const raw = window.WebApp?.initDataUnsafe?.start_param;
  return typeof raw === 'string' ? raw : new URLSearchParams(location.hash.slice(1)).get('WebAppStartParam') || new URLSearchParams(location.search).get('startapp') || '';
}
export function openExternal(url: string) { if (!/^https:\/\//.test(url)) return; if (window.WebApp?.openLink && initData()) window.WebApp.openLink(url); else window.open(url, '_blank', 'noopener,noreferrer'); }
export function share(url: string, text: string) { openExternal(`https://max.ru/:share?text=${encodeURIComponent(`${text}\n${url}`)}`); }
