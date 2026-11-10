"""Landmark registry (D-051): one file per landmark in worlds/_landmarks/<id>.yaml.

A region lists landmarks by id (or with overrides) under `objects.landmarks`;
loading the region expands each reference into the inline form that
objects.place uses. A landmark file holds:

    name: Stratosphere Tower        # reference only: never drawn (generic signage)
    wikidata: Q1149457
    anchor: { lon: -115.1555, lat: 36.1474 }   # or line: [[lon, lat], [lon, lat]]
    height: 350                     # metres (towers, wheels)
    crest: 376                      # metres above sea level (dam crests, bridge decks)
    reservoir: 10                   # a dam's lake stands this many metres below its crest
    base: 0                         # metres: a long landmark's foot (a bridge's water level)
    snap: true                      # a bridge turns to the grid direction of its road (D-049)
    thickness: 45                   # metres across a line landmark
    bulge: 0.15                     # how far a line landmark bows to the left of its direction
    clear: 45                       # metres kept free of other buildings
    orient: 1                       # quarter turns
    scale: 1.0                      # extra depiction scale for this landmark
    replaces: [Stratosphere Tower]  # Overture building names or ids it stands in for
    parts:                          # sub-objects placed along a line landmark
      - { group: landmark.dam.intake, along: 0.15, offset: 70, aboveCrest: 12 }  # offset: left
    hero: true                      # baked offline and painted over (D-053): files in <id>/
    depictions:                     # variant → group (+ params); `generic` is required
      generic: { group: landmark.tower.observation }
      stylized: { group: landmark.tower.observation.stylized }

The region picks a depiction variant with `objects.landmarkDepiction` (default
`generic`): generic depictions carry no names, logos or trademarked designs,
so they are safe for any release; other variants fall back to generic.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .region import RegionError

REGISTRY_DIRNAME = "_landmarks"


class LandmarkError(RegionError):
    """A landmark reference or registry file that can't be used (a spec error)."""


def registry_dir(spec_path: Path) -> Path | None:
    """The nearest `_landmarks` directory at or above the spec's directory."""
    for d in [spec_path.parent, *spec_path.parent.parents]:
        cand = d / REGISTRY_DIRNAME
        if cand.is_dir():
            return cand
    return None


def load_landmark(root: Path, landmark_id: str) -> dict[str, Any]:
    path = root / f"{landmark_id}.yaml"
    if not path.exists():
        raise LandmarkError(f"no landmark '{landmark_id}' in {root}")
    raw = yaml.safe_load(path.read_text()) or {}
    if "generic" not in (raw.get("depictions") or {}):
        raise LandmarkError(f"landmark '{landmark_id}' needs a generic depiction")
    if ("anchor" in raw) == ("line" in raw):
        raise LandmarkError(f"landmark '{landmark_id}' needs exactly one of anchor and line")
    return raw


def resolve(entry: Any, root: Path | None, variant: str) -> dict[str, Any]:
    """One `objects.landmarks` entry → the inline form objects.place reads."""
    if isinstance(entry, dict) and "group" in entry:
        return dict(entry)  # inline landmark (the pre-registry form)
    ref = {"id": entry} if isinstance(entry, str) else dict(entry)
    if "id" not in ref:
        raise LandmarkError(f"landmark entry {entry!r} needs an id or a group")
    if root is None:
        raise LandmarkError("landmark references need a worlds/_landmarks directory")
    raw = load_landmark(root, ref["id"])
    depictions = raw["depictions"]
    dep = dict(depictions.get(variant) or depictions["generic"])
    out: dict[str, Any] = {"id": ref["id"], "group": dep["group"]}
    if "anchor" in raw:
        out["lon"] = float(raw["anchor"]["lon"])
        out["lat"] = float(raw["anchor"]["lat"])
    else:
        out["line"] = [[float(a), float(b)] for a, b in raw["line"]]
    for src, dst in (
        ("height", "hm"),
        ("crest", "crestMeters"),
        ("thickness", "thicknessM"),
        ("bulge", "bulge"),
        ("clear", "clear"),
        ("orient", "orient"),
        ("scale", "scale"),
        ("base", "baseMeters"),
        ("snap", "snap"),
        ("reservoir", "reservoir"),
    ):
        if src in raw:
            out[dst] = raw[src]
    if raw.get("replaces"):
        out["replaces"] = [str(r) for r in raw["replaces"]]
    if raw.get("parts"):
        out["parts"] = [dict(p) for p in raw["parts"]]
    if raw.get("hero"):
        out["hero"] = True  # baked offline and painted over (D-053)
    # the region's entry can override anything (e.g. scale for one level)
    out |= {k: v for k, v in ref.items() if k != "id"}
    return out


def expand(spec: dict[str, Any], spec_path: Path) -> dict[str, Any]:
    """Expand landmark references in a loaded region spec (returns a new spec)."""
    objects = spec.get("objects")
    if not objects or not objects.get("landmarks"):
        return spec
    variant = str(objects.get("landmarkDepiction", "generic"))
    root = registry_dir(spec_path)
    landmarks = [resolve(e, root, variant) for e in objects["landmarks"]]
    return {**spec, "objects": {**objects, "landmarks": landmarks}}


def hero_files(root: Path, landmark_id: str, world_id: str) -> list[dict[str, Any]]:
    """The offline bakes and paint-overs of a hero landmark for one world:
    <id>/hero/<world>/r<n>.png + .json and <id>/paint/<world>/r<n>.png. Rotations
    without both files are skipped (not baked yet)."""
    import json

    out = []
    for r in range(4):
        bake = root / landmark_id / "hero" / world_id / f"r{r}.png"
        meta = bake.with_suffix(".json")
        paint = root / landmark_id / "paint" / world_id / f"r{r}.png"
        if bake.exists() and meta.exists() and paint.exists():
            out.append(
                {"rotation": r, "bake": bake, "paint": paint, "meta": json.loads(meta.read_text())}
            )
    return out
