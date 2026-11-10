"""Elastic map (docs/architecture.md §6): a smooth, fold-free map from region
metres to world cells that follows a target scale field.

Frames:
  source: projected metres in the region CRS, shifted so (0, 0) is the
          envelope's north-west corner and y grows southward;
  output: world cells (x east, y south), the region covering [0, W] × [0, H].

v1 (separable) integrates the cell density along each axis. v2 lays a
triangle mesh over the region and solves for vertex positions so that every
triangle is as close as possible to a similarity transform at its target
scale (local/global iterations: a closed-form rotation per triangle, then one
prefactored sparse solve per axis). The boundary slides along a rectangle
whose size is solved too; pins are soft positional constraints. A solution
with any inverted triangle is rejected (fold check).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla


@dataclass(frozen=True)
class Focus:
    """An area drawn at a finer scale. Inside `radius_m` the target scale holds;
    it blends back to the background over `falloff_m` (smoothstep in log scale)."""

    name: str
    x: float  # source metres
    y: float
    radius_m: float
    meters_per_cell: float
    falloff_m: float


@dataclass(frozen=True)
class Pin:
    """Keep source point (x, y) (source metres) at output position (cx, cy) (cells)."""

    name: str
    x: float
    y: float
    cx: float
    cy: float


@dataclass
class ScaleField:
    """Target metres per cell over the source frame."""

    background: float
    focus: list[Focus] = field(default_factory=list)
    # optional extra term: (grid of metres per cell, origin, cell size), from importance
    extra: tuple[np.ndarray, tuple[float, float], float] | None = None

    def at(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Metres per cell at source points (the finest of all terms)."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        lb = math.log(self.background)
        out = np.full(np.broadcast(x, y).shape, lb)
        for f in self.focus:
            d = np.hypot(x - f.x, y - f.y)
            t = np.clip((d - f.radius_m) / max(f.falloff_m, 1.0), 0.0, 1.0)
            w = 1.0 - t * t * (3.0 - 2.0 * t)  # 1 in the core, smooth to 0
            out = np.minimum(out, lb + w * (math.log(f.meters_per_cell) - lb))
        if self.extra is not None:
            grid, (ox, oy), cs = self.extra
            gy = np.clip(((y - oy) / cs).astype(np.int64), 0, grid.shape[0] - 1)
            gx = np.clip(((x - ox) / cs).astype(np.int64), 0, grid.shape[1] - 1)
            out = np.minimum(out, np.log(grid[gy, gx]))
        return np.exp(out)


@dataclass
class Mesh:
    """Regular triangulated grid over [0, width] × [0, height] source metres."""

    spacing: float
    nx: int  # squares along x
    ny: int
    points: np.ndarray  # (nv, 2) source metres
    tris: np.ndarray  # (nt, 3) vertex indices, counter-clockwise in a y-down frame

    @staticmethod
    def grid(width: float, height: float, spacing: float) -> Mesh:
        nx = max(1, math.ceil(width / spacing))
        ny = max(1, math.ceil(height / spacing))
        xs = np.linspace(0.0, width, nx + 1)
        ys = np.linspace(0.0, height, ny + 1)
        gx, gy = np.meshgrid(xs, ys)
        points = np.column_stack([gx.ravel(), gy.ravel()])
        i = np.arange(ny)[:, None] * (nx + 1) + np.arange(nx)[None, :]
        a, b, c, d = i, i + 1, i + nx + 2, i + nx + 1  # square corners NW, NE, SE, SW
        tris = np.concatenate(
            [np.stack([a, b, c], -1).reshape(-1, 3), np.stack([a, c, d], -1).reshape(-1, 3)]
        )
        return Mesh(width / nx, nx, ny, points, tris)

    @property
    def size(self) -> tuple[float, float]:
        return float(self.points[:, 0].max()), float(self.points[:, 1].max())

    def locate(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Triangle index and barycentric weights (n, 3) for source points (clamped to the mesh)."""
        w, h = self.size
        sx = w / self.nx
        sy = h / self.ny
        fx = np.clip(np.asarray(x, dtype=np.float64) / sx, 0.0, self.nx - 1e-9)
        fy = np.clip(np.asarray(y, dtype=np.float64) / sy, 0.0, self.ny - 1e-9)
        i = np.floor(fx).astype(np.int64)
        j = np.floor(fy).astype(np.int64)
        u = fx - i
        v = fy - j
        sq = j * self.nx + i
        upper = u >= v  # triangle (NW, NE, SE)
        tri = np.where(upper, sq, sq + self.nx * self.ny)
        # barycentrics in the unit square: NW(0,0) NE(1,0) SE(1,1) SW(0,1)
        b = np.where(
            upper[:, None],
            np.stack([1 - u, u - v, v], -1),
            np.stack([1 - v, u, v - u], -1),
        )
        return tri, b


@dataclass
class Warp:
    """A solved map. `uv` holds the output position (cells) of every mesh vertex."""

    mesh: Mesh
    uv: np.ndarray  # (nv, 2) cells
    width: float  # cells
    height: float
    method: str
    stats: dict[str, Any] = field(default_factory=dict)
    _buckets: Any = None

    # ---- forward ------------------------------------------------------------------

    def to_cells(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Source metres → cells."""
        shape = np.shape(x)
        tri, b = self.mesh.locate(np.ravel(x), np.ravel(y))
        v = self.mesh.tris[tri]
        out = (self.uv[v] * b[..., None]).sum(axis=1)
        return out[:, 0].reshape(shape), out[:, 1].reshape(shape)

    def jacobians(self) -> np.ndarray:
        """(nt, 2, 2) Jacobian of the map per triangle, cells per metre."""
        return _jacobians(self.mesh, self.uv)

    def meters_per_cell(self) -> np.ndarray:
        """Achieved scale per triangle (area-equivalent metres per cell)."""
        det = np.linalg.det(self.jacobians())
        return 1.0 / np.sqrt(np.maximum(det, 1e-30))

    # ---- inverse ------------------------------------------------------------------

    def to_source(self, cx: np.ndarray, cy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Cells → source metres (points outside the output rectangle are clamped onto it)."""
        shape = np.shape(cx)
        qx = np.clip(np.ravel(cx).astype(np.float64), 0.0, self.width)
        qy = np.clip(np.ravel(cy).astype(np.float64), 0.0, self.height)
        tri, b = self._locate_output(qx, qy)
        v = self.mesh.tris[tri]
        out = (self.mesh.points[v] * b[..., None]).sum(axis=1)
        return out[:, 0].reshape(shape), out[:, 1].reshape(shape)

    def scale_at_cells(self, cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
        """Achieved metres per cell at output points."""
        shape = np.shape(cx)
        qx = np.clip(np.ravel(cx).astype(np.float64), 0.0, self.width)
        qy = np.clip(np.ravel(cy).astype(np.float64), 0.0, self.height)
        tri, _ = self._locate_output(qx, qy)
        return self.meters_per_cell()[tri].reshape(shape)

    def _locate_output(self, qx: np.ndarray, qy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if self._buckets is None:
            self._buckets = _Buckets(self.uv, self.mesh.tris)
        return self._buckets.locate(qx, qy)


class _Buckets:
    """Point location in the output mesh via a uniform bucket grid."""

    def __init__(self, uv: np.ndarray, tris: np.ndarray):
        self.uv = uv
        self.tris = tris
        p = uv[tris]  # (nt, 3, 2)
        lo = p.min(axis=1)
        hi = p.max(axis=1)
        ext = float(np.median(hi - lo)) or 1.0
        self.b = max(ext, 1e-6)
        self.ox, self.oy = float(uv[:, 0].min()), float(uv[:, 1].min())
        self.nbx = int((uv[:, 0].max() - self.ox) / self.b) + 1
        self.nby = int((uv[:, 1].max() - self.oy) / self.b) + 1
        bx0 = ((lo[:, 0] - self.ox) / self.b).astype(np.int64)
        by0 = ((lo[:, 1] - self.oy) / self.b).astype(np.int64)
        bx1 = ((hi[:, 0] - self.ox) / self.b).astype(np.int64)
        by1 = ((hi[:, 1] - self.oy) / self.b).astype(np.int64)
        span = int(max((bx1 - bx0).max(), (by1 - by0).max())) + 1
        pairs_b, pairs_t = [], []
        t = np.arange(len(tris))
        for dy in range(span):
            for dx in range(span):
                ok = (bx0 + dx <= bx1) & (by0 + dy <= by1)
                pairs_b.append(((by0 + dy) * self.nbx + bx0 + dx)[ok])
                pairs_t.append(t[ok])
        bb = np.concatenate(pairs_b)
        tt = np.concatenate(pairs_t)
        order = np.argsort(bb, kind="stable")
        self.tri_of = tt[order]
        counts = np.bincount(bb, minlength=self.nbx * self.nby)
        self.start = np.concatenate([[0], np.cumsum(counts)[:-1]])
        self.count = counts

    def locate(self, qx: np.ndarray, qy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        bx = np.clip(((qx - self.ox) / self.b).astype(np.int64), 0, self.nbx - 1)
        by = np.clip(((qy - self.oy) / self.b).astype(np.int64), 0, self.nby - 1)
        bucket = by * self.nbx + bx
        n = len(qx)
        best_tri = np.zeros(n, dtype=np.int64)
        best_bary = np.zeros((n, 3))
        best_score = np.full(n, -np.inf)  # min barycentric: ≥ 0 means inside
        for k in range(int(self.count.max(initial=0))):
            has = self.count[bucket] > k
            idx = np.nonzero(has)[0]
            if not len(idx):
                break
            t = self.tri_of[self.start[bucket[idx]] + k]
            b = _barycentric(self.uv[self.tris[t]], qx[idx], qy[idx])
            score = b.min(axis=1)
            better = score > best_score[idx]
            sel = idx[better]
            best_tri[sel] = t[better]
            best_bary[sel] = b[better]
            best_score[sel] = score[better]
        # clamp tiny negatives from points on edges or just outside
        best_bary = np.clip(best_bary, 0.0, None)
        best_bary /= best_bary.sum(axis=1, keepdims=True)
        return best_tri, best_bary


def _barycentric(p: np.ndarray, qx: np.ndarray, qy: np.ndarray) -> np.ndarray:
    a, b, c = p[:, 0], p[:, 1], p[:, 2]
    v0 = b - a
    v1 = c - a
    v2 = np.stack([qx - a[:, 0], qy - a[:, 1]], -1)
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    den = np.where(np.abs(den) < 1e-300, 1e-300, den)
    l1 = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den
    l2 = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den
    return np.stack([1 - l1 - l2, l1, l2], -1)


def _edge_inverse(mesh: Mesh) -> tuple[np.ndarray, np.ndarray]:
    p = mesh.points[mesh.tris]
    e = np.stack([p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]], axis=2)  # (nt, 2, 2) columns
    area = 0.5 * np.abs(np.linalg.det(e))
    return np.linalg.inv(e), area


def _jacobians(mesh: Mesh, uv: np.ndarray) -> np.ndarray:
    einv, _ = _edge_inverse(mesh)
    q = uv[mesh.tris]
    u = np.stack([q[:, 1] - q[:, 0], q[:, 2] - q[:, 0]], axis=2)
    return u @ einv


def signed_areas(mesh: Mesh, uv: np.ndarray) -> np.ndarray:
    q = uv[mesh.tris]
    a, b, c = q[:, 0], q[:, 1], q[:, 2]
    return 0.5 * (
        (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    )


# ---- v1: separable ---------------------------------------------------------------------


def solve_v1(mesh: Mesh, sf: ScaleField, power: float = 2.0) -> Warp:
    """x' = F(x), y' = G(y): each axis integrates a power mean of the cell density."""
    w, h = mesh.size
    xs = np.linspace(0.0, w, mesh.nx + 1)
    ys = np.linspace(0.0, h, mesh.ny + 1)
    gx, gy = np.meshgrid(xs, ys)
    rho = 1.0 / sf.at(gx, gy)  # cells per metre at vertices, (ny+1, nx+1)
    col = np.mean(rho**power, axis=0) ** (1.0 / power)
    row = np.mean(rho**power, axis=1) ** (1.0 / power)
    fx = np.concatenate([[0.0], np.cumsum(0.5 * (col[1:] + col[:-1]) * np.diff(xs))])
    fy = np.concatenate([[0.0], np.cumsum(0.5 * (row[1:] + row[:-1]) * np.diff(ys))])
    uv = np.column_stack([np.tile(fx, mesh.ny + 1), np.repeat(fy, mesh.nx + 1)])
    warp = Warp(mesh, uv, float(fx[-1]), float(fy[-1]), "v1")
    warp.stats = _stats(warp, sf, [])
    return warp


# ---- v2: fold-free mesh solve ------------------------------------------------------------


def _sd_energy(mesh: Mesh, uv: np.ndarray, einv, sigma, weight) -> float:
    """Weighted symmetric Dirichlet energy of J/σ per triangle (inf if anything folds)."""
    q = uv[mesh.tris]
    u = np.stack([q[:, 1] - q[:, 0], q[:, 2] - q[:, 0]], axis=2)
    m = (u @ einv) / sigma[:, None, None]
    det = m[:, 0, 0] * m[:, 1, 1] - m[:, 0, 1] * m[:, 1, 0]
    if (det <= 0).any():
        return math.inf
    fro = (m**2).sum(axis=(1, 2))
    return float((weight * (fro + fro / det**2)).sum())


def _max_step(mesh: Mesh, uv: np.ndarray, d: np.ndarray) -> float:
    """Largest step along d (≤ 1e9) before any output triangle's area reaches zero."""
    q = uv[mesh.tris]
    r = d[mesh.tris]
    e1, e2 = q[:, 1] - q[:, 0], q[:, 2] - q[:, 0]
    f1, f2 = r[:, 1] - r[:, 0], r[:, 2] - r[:, 0]
    cross = lambda a, b: a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]  # noqa: E731
    a = cross(f1, f2)
    b = cross(e1, f2) + cross(f1, e2)
    c = cross(e1, e2)
    t = np.full(len(a), np.inf)
    lin = np.abs(a) < 1e-14
    with np.errstate(invalid="ignore", divide="ignore"):
        tl = -c / b
        t = np.where(lin & (b < 0), tl, t)
        disc = b * b - 4 * a * c
        sq = np.sqrt(np.maximum(disc, 0))
        r1 = (-b - sq) / (2 * a)
        r2 = (-b + sq) / (2 * a)
        for root in (r1, r2):
            ok = ~lin & (disc >= 0) & (root > 0)
            t = np.where(ok, np.minimum(t, root), t)
    return float(min(t.min(), 1e9))


def solve_v2(
    mesh: Mesh,
    sf: ScaleField,
    pins: list[Pin] | None = None,
    iterations: int = 30,
    pin_weight: float = 1e3,
    init: Warp | None = None,
    focus_weight: float = 2.0,
    tolerance: float = 1e-4,
) -> Warp:
    """Fold-free solve of the map toward the target scale field.

    Energy: Σ_t w_t · SD(J_t / σ_t), where SD is the symmetric Dirichlet energy
    (‖M‖² + ‖M⁻¹‖²), minimal for a similarity at the triangle's target scale σ_t
    and infinite at inversion. w_t is the source area times the target
    magnification^focus_weight (2 counts distortion by output area). Minimised
    by reweighted local/global steps (SLIM, Rabinovich et al. 2017) with a
    line search that never lets a triangle flip, starting from the fold-free
    separable map. The boundary slides along a rectangle of solved size.
    """
    t0 = time.perf_counter()
    pins = pins or []
    init = init or solve_v1(mesh, sf)
    nv = len(mesh.points)
    nt = len(mesh.tris)
    einv, area = _edge_inverse(mesh)
    G = np.stack(
        [-(einv[:, 0, :] + einv[:, 1, :]), einv[:, 0, :], einv[:, 1, :]], axis=1
    )  # (nt,3,2)
    cen = mesh.points[mesh.tris].mean(axis=1)
    sigma = 1.0 / sf.at(cen[:, 0], cen[:, 1])
    weight = area * (sigma * sf.background) ** focus_weight

    # unknowns: x of every vertex, then y; boundary constraints reduce them (P, offset 0)
    w_src, h_src = mesh.size
    px, py = mesh.points[:, 0], mesh.points[:, 1]
    eps = 1e-6 * max(w_src, h_src)
    blocks = []
    n_red = 0
    for lo_mask, hi_mask in ((px <= eps, px >= w_src - eps), (py <= eps, py >= h_src - eps)):
        free = ~(lo_mask | hi_mask)
        idx = np.full(nv, -1)
        idx[free] = n_red + np.arange(free.sum())
        n_red += int(free.sum())
        ext = n_red
        n_red += 1
        blocks.append((free, hi_mask, idx, ext))
    rows, cols = [], []
    for axis, (free, hi_mask, idx, ext) in enumerate(blocks):
        rows += [axis * nv + np.nonzero(free)[0], axis * nv + np.nonzero(hi_mask)[0]]
        cols += [idx[free], np.full(hi_mask.sum(), ext)]
    r = np.concatenate(rows)
    P = sp.csr_matrix((np.ones(len(r)), (r, np.concatenate(cols))), shape=(2 * nv, n_red))

    # soft pins on both coordinates
    pin_A = None
    if pins:
        prow, pcol, pval, ptgt = [], [], [], []
        for k, p in enumerate(pins):
            tri, b = mesh.locate(np.array([p.x]), np.array([p.y]))
            for axis, tgt in ((0, p.cx), (1, p.cy)):
                for v, bv in zip(mesh.tris[tri[0]], b[0], strict=True):
                    prow.append(2 * k + axis)
                    pcol.append(axis * nv + v)
                    pval.append(bv)
                ptgt.append(tgt)
        pin_A = sp.csr_matrix((pval, (prow, pcol)), shape=(2 * len(pins), 2 * nv))
        pin_b = np.array(ptgt)

    # residual layout: (t, r, k) → row 4t + 2r + k; columns (axis c, vertex v)
    tri_rows = (4 * np.arange(nt))[:, None, None, None] + (2 * np.arange(2))[None, :, None, None]
    uv = init.uv.copy()
    energy = _sd_energy(mesh, uv, einv, sigma, weight)
    pin_scale = None
    iters = 0
    for step_no in range(1, iterations + 1):
        iters = step_no
        q = uv[mesh.tris]
        J = np.einsum("tvk,tvc->tck", G, q)
        M = J / sigma[:, None, None]
        U, S, Vt = np.linalg.svd(M)
        flip = np.linalg.det(U @ Vt) < 0
        U[flip, :, 1] *= -1
        S[flip, 1] *= -1
        R = U @ Vt
        s = np.clip(S, 1e-6, None)
        wdiag = np.sqrt((s + 1) * (s * s + 1) / s**3)
        Wt = U @ (wdiag[:, :, None] * np.swapaxes(U, 1, 2))  # (nt,2,2) symmetric
        # residual (t,r,k) = Σ_c Σ_v W[r,c] G[v,k] u[v,c] / σ − (W R)[r,k], scaled by sqrt(w)
        sw = np.sqrt(weight) / sigma
        coef = Wt[:, :, :, None, None] * G[:, None, None, :, :]  # (t, r, c, v, k)
        coef = np.transpose(coef, (0, 1, 4, 2, 3)) * sw[:, None, None, None, None]  # (t,r,k,c,v)
        row = np.broadcast_to(tri_rows + np.arange(2)[None, None, :, None], (nt, 2, 2, 1))
        row = np.broadcast_to(row[..., None], (nt, 2, 2, 2, 3))
        col = np.arange(2)[None, None, None, :, None] * nv + mesh.tris[:, None, None, None, :]
        col = np.broadcast_to(col, (nt, 2, 2, 2, 3))
        A = sp.csr_matrix((coef.ravel(), (row.ravel(), col.ravel())), shape=(4 * nt, 2 * nv))
        b = (np.sqrt(weight)[:, None, None] * (Wt @ R)).ravel()
        N = A.T @ A
        rhs = A.T @ b
        if pin_A is not None:
            if pin_scale is None:
                pin_scale = pin_weight * float(N.diagonal().mean())
            N = N + pin_scale * (pin_A.T @ pin_A)
            rhs = rhs + pin_scale * (pin_A.T @ pin_b)
        z = spla.splu((P.T @ N @ P).tocsc()).solve(P.T @ rhs)
        target = (P @ z).reshape(2, nv).T
        d = target - uv
        step = min(1.0, 0.9 * _max_step(mesh, uv, d))
        new_energy = math.inf
        while step > 1e-8:
            cand = uv + step * d
            new_energy = _sd_energy(mesh, cand, einv, sigma, weight)
            if new_energy <= energy:
                break
            step *= 0.5
        if not math.isfinite(new_energy) or new_energy > energy:
            break
        uv = cand
        done = (energy - new_energy) < tolerance * energy
        energy = new_energy
        if done:
            break
    width = float(uv[:, 0].max())
    height = float(uv[:, 1].max())
    warp = Warp(mesh, uv, width, height, "v2")
    warp.stats = _stats(warp, sf, pins)
    warp.stats["iterations"] = iters
    warp.stats["solveSeconds"] = round(time.perf_counter() - t0, 3)
    return warp


def _stats(warp: Warp, sf: ScaleField, pins: list[Pin]) -> dict[str, Any]:
    areas = signed_areas(warp.mesh, warp.uv)
    j = warp.jacobians()
    s = np.linalg.svd(j, compute_uv=False)
    aniso = s[:, 0] / np.maximum(s[:, 1], 1e-30)
    focus = []
    for f in sf.focus:
        tri, _ = warp.mesh.locate(np.array([f.x]), np.array([f.y]))
        achieved = float(warp.meters_per_cell()[tri[0]])
        focus.append(
            {
                "name": f.name,
                "target": f.meters_per_cell,
                "achieved": round(achieved, 1),
                "error": round(achieved / f.meters_per_cell - 1.0, 3),
            }
        )
    pin_err = []
    for p in pins:
        cx, cy = warp.to_cells(np.array([p.x]), np.array([p.y]))
        pin_err.append(
            {"name": p.name, "cells": round(float(np.hypot(cx[0] - p.cx, cy[0] - p.cy)), 2)}
        )
    return {
        "method": warp.method,
        "cells": [math.ceil(warp.width), math.ceil(warp.height)],
        "folds": int((areas <= 0).sum()),
        "maxAnisotropy": round(float(aniso.max()), 3),
        "focus": focus,
        "pins": pin_err,
    }


def solve(
    width_m: float,
    height_m: float,
    sf: ScaleField,
    pins: list[Pin] | None = None,
    method: str = "v2",
    spacing_m: float = 2000.0,
    iterations: int = 40,
    focus_weight: float = 3.0,
    corrections: int = 2,
) -> Warp:
    """Solve a warp over a width × height metre region. Raises if the result folds.

    v2 runs `corrections` extra passes that rescale each focus area's internal
    target by its measured error (warm-started from the previous fold-free
    solution), so focus cores land close to their requested scale.
    """
    mesh = Mesh.grid(width_m, height_m, spacing_m)
    v1 = solve_v1(mesh, sf)
    if method == "v1":
        warp = v1
    elif method == "v2":
        t0 = time.perf_counter()
        inner = ScaleField(sf.background, list(sf.focus), sf.extra)
        warp = solve_v2(
            mesh, inner, pins, iterations=iterations, init=v1, focus_weight=focus_weight
        )
        for _ in range(corrections):
            achieved = {f["name"]: f["achieved"] for f in warp.stats["focus"]}
            adjusted = []
            for want, f in zip(sf.focus, inner.focus, strict=True):
                ratio = achieved[f.name] / want.meters_per_cell
                adjusted.append(
                    Focus(f.name, f.x, f.y, f.radius_m, f.meters_per_cell / ratio, f.falloff_m)
                )
            inner = ScaleField(sf.background, adjusted, sf.extra)
            warp = solve_v2(
                mesh, inner, pins, iterations=iterations, init=warp, focus_weight=focus_weight
            )
        # report against the requested targets, not the corrected internal ones
        warp.stats = _stats(warp, sf, pins or [])
        warp.stats["solveSeconds"] = round(time.perf_counter() - t0, 3)
    else:
        raise ValueError(f"unknown warp method {method!r}")
    if warp.stats["folds"]:
        raise WarpError(f"warp folds: {warp.stats['folds']} inverted triangles")
    return warp


class WarpError(ValueError):
    pass
