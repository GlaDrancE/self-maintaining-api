import { getWidget } from './api.js';

// One hop from a request — the caller pass must find this.
export async function widgetName(id) {
  const w = await getWidget(id);
  return w.name;
}
