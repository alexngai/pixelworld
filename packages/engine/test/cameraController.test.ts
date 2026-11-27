import { describe, expect, it, vi } from "vitest";
import { cameraController } from "../src/cameraController";
import type { ControllerView, ViewCamera } from "../src/types";

function fakeView() {
  const pans: [number, number][] = [];
  const rotations: (1 | -1)[] = [];
  const camera = {
    x: 10,
    y: 10,
    h: 0,
    rotation: 0,
    zoom: 3,
    autoZoom: false,
    internalWidth: 640,
    internalHeight: 360,
    pan: (dx: number, dy: number) => pans.push([dx, dy]),
    rotate: (d: 1 | -1) => rotations.push(d),
    setFocus() {},
    lookAt: async () => true,
    screenDirToGrid: (dx: number, dy: number) => [dx, dy] as [number, number],
    project: () => ({ x: 0, y: 0, onScreen: true }),
  } as unknown as ViewCamera;
  const add = vi.fn();
  const view = {
    canvas: { setPointerCapture: vi.fn() } as unknown as HTMLCanvasElement,
    camera,
    entities: { add, remove: vi.fn(), list: () => [] },
    pixelRatio: 2,
  } as unknown as ControllerView;
  return { view, camera, pans, rotations, add };
}

describe("cameraController", () => {
  it("pans with WASD and pointer drag, rotates with Q/E, zooms with 1–6, and spawns no entities", () => {
    const { view, camera, pans, rotations, add } = fakeView();
    const ctrl = cameraController({ panSpeed: 100 });
    ctrl.attach(view);
    expect(add).not.toHaveBeenCalled();

    expect(ctrl.keyDown({ key: "q" })).toBe(true);
    expect(ctrl.keyDown({ key: "e" })).toBe(true);
    expect(rotations).toEqual([-1, 1]);

    expect(ctrl.keyDown({ key: "4" })).toBe(true);
    expect(camera.zoom).toBe(4);

    // does not intercept rover-only keys
    expect(ctrl.keyDown({ key: "ArrowUp" })).toBe(false);
    expect(ctrl.keyDown({ key: "f" })).toBe(false);
    expect(ctrl.keyDown({ key: "n" })).toBe(false);

    expect(ctrl.keyDown({ key: "d" })).toBe(true);
    ctrl.update(0.5);
    expect(pans[0]).toEqual([50, 0]);
    ctrl.keyUp({ key: "d" });

    ctrl.pointerDown({ clientX: 10, clientY: 20, pointerId: 1 });
    ctrl.pointerMove({ clientX: 30, clientY: 10 });
    ctrl.pointerUp();
    // scale = pixelRatio (2) / zoom (4) = 0.5
    expect(pans[1]).toEqual([-10, 5]);
    ctrl.detach();
  });
});
