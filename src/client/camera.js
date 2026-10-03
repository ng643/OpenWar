import { W, H } from '../config.js';
import { clamp } from '../util.js';

/** Camera: x/y = top-left in tile coords, z = screen pixels per tile, vw/vh = viewport in CSS px.
 *  w/h are the bounds of the current map; setBounds() re-points them whenever a game starts. */
export function createCamera() {
  return { x: 0, y: 0, z: 8, vw: 1, vh: 1, w: W, h: H };
}

export const toWorld = (cam, px, py) => [px / cam.z + cam.x, py / cam.z + cam.y];

/** Point the camera at the bounds of the world that is being played. */
export function setBounds(cam, w, h) {
  cam.w = w; cam.h = h;
  clampCamera(cam);
}

export const minZoom = cam => Math.min(cam.vw / cam.w, cam.vh / cam.h) * .9;

export function clampCamera(cam) {
  const vw = cam.vw / cam.z, vh = cam.vh / cam.z;
  cam.x = clamp(cam.x, -vw * .4, cam.w - vw * .6);
  cam.y = clamp(cam.y, -vh * .4, cam.h - vh * .6);
}

export function centerOn(cam, wx, wy) {
  cam.x = wx - cam.vw / cam.z / 2;
  cam.y = wy - cam.vh / cam.z / 2;
  clampCamera(cam);
}

export function zoomAt(cam, px, py, factor) {
  const [wx, wy] = toWorld(cam, px, py);
  cam.z = clamp(cam.z * factor, minZoom(cam), 48);
  cam.x = wx - px / cam.z;
  cam.y = wy - py / cam.z;
  clampCamera(cam);
}

export function resetCamera(cam, wx, wy) {
  cam.z = clamp(Math.min(cam.vw / 60, 14), minZoom(cam), 48);
  centerOn(cam, wx, wy);
}
