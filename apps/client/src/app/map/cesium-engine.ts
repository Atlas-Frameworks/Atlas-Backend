// Must run before the `cesium` module (sets CESIUM_BASE_URL).
// oxlint-disable-next-line import/no-unassigned-import
import './cesium-base-url';
import type { Camera } from '@atlas/client-sdk';
import { CesiumAdapter } from '@atlas/map-cesium';
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumWidget,
  Color,
  Credit,
  GridImageryProvider,
  ImageryLayer,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
} from 'cesium';
import type { BasemapConfig } from '../config/environment';
import { ensureStylesheet } from './map-engine';
import type { MapEngine, MapEngineOptions } from './map-engine';

/** Camera height for `flyTo` when none is given: a few hundred km, labels are on below 2,000 km. */
const FLY_TO_HEIGHT_M = 400_000;

function imagery(basemap: BasemapConfig): ImageryLayer {
  if (basemap.url === null) return new ImageryLayer(new GridImageryProvider({}));
  return new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: basemap.url,
      maximumLevel: basemap.maximumLevel ?? 19,
      ...(basemap.credit ? { credit: new Credit(basemap.credit) } : {}),
    }),
  );
}

/**
 * A Cesium globe (`CesiumWidget`, no ion token, no Viewer widgets) with a `CesiumAdapter` on it.
 * The render loop is Cesium's own requestAnimationFrame loop; nothing here touches Angular.
 */
export function createCesiumEngine(container: HTMLElement, options: MapEngineOptions): MapEngine {
  ensureStylesheet(new URL('cesium/Widgets/widgets.css', document.baseURI).href);
  const widget = new CesiumWidget(container, {
    baseLayer: imagery(options.basemap),
    requestRenderMode: options.requestRenderMode ?? true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
  });
  const scene = widget.scene;
  scene.globe.baseColor = Color.fromCssColorString(options.basemap.baseColor);
  scene.camera.setView({ destination: Cartesian3.fromDegrees(10, 30, 18_000_000) });
  scene.camera.percentageChanged = 0.05;
  const adapter = new CesiumAdapter(scene, { points: options.points ?? 'buffer' });

  const clicks = new ScreenSpaceEventHandler(scene.canvas);
  const center = new Cartesian2();
  const ground = new Cartographic();
  const cleanups: (() => void)[] = [];

  /** The ellipsoid point at the canvas centre (the camera position when looking past the globe). */
  const camera = (): Camera => {
    const height = scene.camera.positionCartographic.height;
    center.x = scene.canvas.clientWidth / 2;
    center.y = scene.canvas.clientHeight / 2;
    const hit = scene.camera.pickEllipsoid(center);
    const c = hit
      ? Cartographic.fromCartesian(hit, undefined, ground)
      : scene.camera.positionCartographic;
    return {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      height,
    };
  };

  return {
    adapter,
    locate: (id, layerId) => adapter.locate(id, layerId),
    flyTo(lon, lat, height = FLY_TO_HEIGHT_M) {
      scene.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, height), duration: 1.5 });
    },
    onCameraChange(listener) {
      const fire = () => listener(camera());
      const offChanged = scene.camera.changed.addEventListener(fire);
      const offEnd = scene.camera.moveEnd.addEventListener(fire);
      fire();
      const off = () => {
        offChanged();
        offEnd();
      };
      cleanups.push(off);
      return off;
    },
    onClick(listener) {
      clicks.setInputAction(
        (e: ScreenSpaceEventHandler.PositionedEvent) => listener(e.position.x, e.position.y),
        ScreenSpaceEventType.LEFT_CLICK,
      );
      return () => clicks.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    },
    onRender(listener) {
      const off = scene.postRender.addEventListener(listener);
      cleanups.push(off);
      return off;
    },
    destroy() {
      for (const off of cleanups) off();
      clicks.destroy();
      adapter.destroy();
      widget.destroy();
    },
  };
}
