import { InjectionToken } from '@angular/core';
import type { Camera, MapAdapter } from '@atlas/client-sdk';
import type { BasemapConfig } from '../config/environment';

/** Layer and last drawn position of an entity. */
export interface EntityLocation {
  layerId: string;
  lon: number;
  lat: number;
  alt: number;
}

/**
 * A map renderer plus its SDK adapter, behind one small interface so MapView doesn't depend on
 * Cesium directly (Cesium stays in a lazy chunk; tests use a fake). All callbacks run outside
 * Angular: they come from the map's own DOM listeners and render loop, which the zoneless app
 * never patches, so they schedule no change detection unless they write a signal.
 */
export interface MapEngine {
  readonly adapter: MapAdapter;
  /** Layer and last drawn position of a shown entity (null if not on the map). */
  locate(id: string, layerId?: string): EntityLocation | null;
  /** Moves the camera to look at a point from `height` metres above it. */
  flyTo(lon: number, lat: number, height?: number): void;
  /** The camera's ground point and height; called whenever the camera moved (unthrottled). */
  onCameraChange(listener: (camera: Camera) => void): () => void;
  /** A click on the map, in CSS pixels relative to the map canvas. */
  onClick(listener: (x: number, y: number) => void): () => void;
  /** Called after every rendered map frame (for measurements). */
  onRender(listener: () => void): () => void;
  destroy(): void;
}

export interface MapEngineOptions {
  basemap: BasemapConfig;
  /** Render only when something changed (default true); false renders every animation frame. */
  requestRenderMode?: boolean;
  /** Cesium's plain point collection (default 'buffer'). */
  points?: 'buffer' | 'primitive';
}

export type MapEngineFactory = (
  container: HTMLElement,
  options: MapEngineOptions,
) => Promise<MapEngine>;

/** Creates the map. The default loads Cesium lazily; tests provide a fake. */
export const MAP_ENGINE_FACTORY = new InjectionToken<MapEngineFactory>('MAP_ENGINE_FACTORY', {
  providedIn: 'root',
  factory: () => async (container, options) => {
    const { createCesiumEngine } = await import('./cesium-engine');
    return createCesiumEngine(container, options);
  },
});

/** Adds a `<link rel=stylesheet>` once (map CSS that is not part of the app styles). */
export function ensureStylesheet(href: string): void {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}
