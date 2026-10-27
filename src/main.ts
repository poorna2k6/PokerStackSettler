import '@fontsource/playfair-display/latin-700.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

// A "#/v/CODE" link opens the read-only live view. That path never loads the host app, so it cannot
// touch (or overwrite) any table saved on this device.
const viewing = /^#\/v\/([A-Za-z0-9-]{4,16})$/.exec(location.hash);
window.addEventListener('hashchange', () => location.reload());

if (viewing) {
  void import('./viewer').then(m => m.mountViewer(viewing[1]));
} else {
  void import('./app');
}
