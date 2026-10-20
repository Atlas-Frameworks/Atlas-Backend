import { DeckGlAdapter } from '@atlas/map-deckgl';
import { Map as MapLibreMap } from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { ensureStylesheet } from '../map/map-engine';
import type { MapEngine } from '../map/map-engine';

/** MapLibre with a blank background (no tiles, no network) and the deck.gl adapter on top (C-06). */
export function createDeckGlEngine(container: HTMLElement, background: string): MapEngine {
  ensureStylesheet(new URL('maplibre/maplibre-gl.css', document.baseURI).href);
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': background } }],
  };
  const map = new MapLibreMap({
    container,
    style,
    center: [10, 30],
    zoom: 1.6,
    attributionControl: false,
  });
  const renderListeners = new Set<() => void>();
  const adapter = new DeckGlAdapter(map, {
    overlayProps: {
      onAfterRender: () => {
        for (const l of renderListeners) l();
      },
    },
  });
  return {
    adapter,
    locate: () => null,
    flyTo: (lon, lat) => map.flyTo({ center: [lon, lat], zoom: 6 }),
    onCameraChange(listener) {
      const fire = () => {
        const c = map.getCenter();
        listener({ lon: c.lng, lat: c.lat });
      };
      map.on('move', fire);
      return () => map.off('move', fire);
    },
    onClick(listener) {
      const fire = (e: { point: { x: number; y: number } }) => listener(e.point.x, e.point.y);
      map.on('click', fire);
      return () => map.off('click', fire);
    },
    onRender(listener) {
      renderListeners.add(listener);
      return () => renderListeners.delete(listener);
    },
    destroy() {
      renderListeners.clear();
      adapter.destroy();
      map.remove();
    },
  };
}
