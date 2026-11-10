"""Region spec validation (D-076): every class of mistake the DX review's 20
broken specs made is reported with its file, line and key path, before
anything is built; and the reference in docs/worlds.md is the schema's."""

from pathlib import Path

import pytest
import yaml

from pixelworld_pipeline import api, schema
from pixelworld_pipeline.region import RegionError, SpecError, load_region

REPO = Path(__file__).resolve().parents[2]
WORLDS = REPO / "worlds"

GOOD = """\
id: town
name: Test Town
bounds: [-112.130, 34.738, -112.098, 34.762]
metersPerCell: 20
verticalExaggeration: 2.5
maxSlope: 3
style: desert-southwest
start: { lon: -112.1138, lat: 34.7489 }
sources:
  dem: { kind: usgs-3dep-13arcsec, overview: 1 }
  landcover: { kind: esa-worldcover-2021, overview: 1 }
  overture: { release: 2026-10-21.0 }
  roads: { classes: [primary, residential] }
  rivers: { subtypes: [river, stream] }
objects:
  buildings: { minArea: 40 }
  vegetation:
    - { group: tree.pinyon-juniper, landcover: [tree], spacing: 22, density: 0.45 }
"""


def write(tmp_path, text, name="region.yaml"):
    path = tmp_path / "worlds" / "town" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def problems(tmp_path, text, **files) -> list[schema.Issue]:
    """The issues `pixelworld check` reports for a spec (the file's text)."""
    for name, body in files.items():
        write(tmp_path, body, name)
    _, issues = api.check(write(tmp_path, text))
    return [i for i in issues if i.level == "error"]


def edit(old: str, new: str) -> str:
    assert old in GOOD, old
    return GOOD.replace(old, new)


def line_of(text: str, needle: str) -> int:
    return next(i for i, ln in enumerate(text.splitlines(), 1) if needle in ln)


def test_a_good_spec_has_no_problems(tmp_path):
    assert problems(tmp_path, GOOD) == []


def test_every_spec_in_the_repository_is_valid():
    specs = [
        p
        for p in sorted(WORLDS.glob("*/*.yaml"))
        if not p.parent.name.startswith("_") and p.name != "warp.yaml"
    ]
    assert len(specs) >= 12
    for path in specs:
        region, issues = api.check(path)
        assert issues == [], (path, [str(i) for i in issues])
        assert region is not None


# One case per class of mistake: (what's wrong, the spec's text, the key path,
# the line's text, what the message says).
CASES = [
    (
        "typo in a required key: the spelling, not also 'missing'",
        edit("metersPerCell: 20", "metersPerCel: 20"),
        "metersPerCel",
        "metersPerCel:",
        "unknown key; did you mean 'metersPerCell'?",
    ),
    (
        "typo in an optional key (was silently ignored)",
        edit("verticalExaggeration:", "verticalExageration:"),
        "verticalExageration",
        "verticalExageration:",
        "did you mean 'verticalExaggeration'?",
    ),
    (
        "typo in a nested key",
        edit("  roads: {", "  raods: {"),
        "sources.raods",
        "raods:",
        "unknown key in sources; did you mean 'roads'?",
    ),
    (
        "unknown value, with a suggestion",
        edit("[primary, residential]", "[primary, residental]"),
        "sources.roads.classes[1]",
        "roads:",
        "unknown value 'residental'; did you mean 'residential'?",
    ),
    (
        "text for a number",
        edit("metersPerCell: 20", "metersPerCell: twenty"),
        "metersPerCell",
        "metersPerCell:",
        "must be a number, not the text 'twenty'",
    ),
    (
        "a number for a box",
        edit("bounds: [-112.130, 34.738, -112.098, 34.762]", "bounds: -112.1"),
        "bounds",
        "bounds:",
        "must be [west, south, east, north], not a number",
    ),
    (
        "a fraction for a whole number (was silently truncated)",
        edit("maxSlope: 3", "maxSlope: 2.7"),
        "maxSlope",
        "maxSlope:",
        "must be a whole number, not 2.7",
    ),
    (
        "out of range",
        edit("maxSlope: 3", "maxSlope: 4"),
        "maxSlope",
        "maxSlope:",
        "must be 1–3, not 4",
    ),
    (
        "one value for a list",
        edit("[primary, residential]", "primary"),
        "sources.roads.classes",
        "roads:",
        "must be a list, not the text 'primary': write [primary]",
    ),
    (
        "a missing source",
        edit("  landcover: { kind: esa-worldcover-2021, overview: 1 }\n", ""),
        "sources.landcover",
        "sources:",
        "is missing (required)",
    ),
    (
        "a date where text belongs (YAML reads 2026-10-21 as a date)",
        edit("release: 2026-10-21.0", "release: 2026-10-21"),
        "sources.overture.release",
        "overture:",
        "YAML read 2026-10-21 as a date; quote it",
    ),
    (
        "an unknown style pack (the viewer failed later)",
        edit("style: desert-southwest", "style: desert"),
        "style",
        "style:",
        "no style pack 'desert'",
    ),
    (
        "a start outside the bounds",
        edit("start: { lon: -112.1138", "start: { lon: -100.0"),
        "start",
        "start:",
        "must lie inside bounds",
    ),
    (
        "a vegetation rule with nothing to grow on",
        edit("landcover: [tree], ", ""),
        "objects.vegetation[0]",
        "- { group: tree",
        "needs `landcover`",
    ),
    (
        "an unknown land-cover class",
        edit("landcover: [tree]", "landcover: [trees]"),
        "objects.vegetation[0].landcover[0]",
        "- { group: tree",
        "did you mean 'tree'?",
    ),
]


@pytest.mark.parametrize("why,text,key,line_text,message", CASES, ids=[c[0] for c in CASES])
def test_each_mistake_is_reported_at_its_key_and_line(tmp_path, why, text, key, line_text, message):
    issues = problems(tmp_path, text)
    hits = [i for i in issues if schema.dotted(i.path) == key]
    assert hits, [str(i) for i in issues]
    issue = hits[0]
    assert message in issue.message
    assert issue.file == tmp_path / "worlds" / "town" / "region.yaml"
    assert issue.line == line_of(text, line_text), str(issue)
    assert str(issue).startswith(f"{issue.file}:{issue.line}: {key}: ")
    if "typo in a required key" in why:
        assert len(issues) == 1  # not also "metersPerCell is missing"


def test_the_style_suggestion_names_the_packs(tmp_path):
    (issue,) = problems(tmp_path, edit("style: desert-southwest", "style: desert"))
    assert "did you mean 'desert-southwest'?" in issue.message
    assert "bay-area" in issue.message


def test_yaml_syntax_errors_name_the_file_and_line(tmp_path):
    text = edit("maxSlope: 3", "maxSlope: [3")
    with pytest.raises(SpecError) as e:
        load_region(write(tmp_path, text))
    (issue,) = e.value.issues
    assert issue.file.name == "region.yaml" and issue.line == line_of(text, "style:")
    assert "YAML syntax error" in str(e.value) and "region.yaml:" in str(e.value)


def test_files_a_spec_names_must_exist(tmp_path):
    (issue,) = problems(tmp_path, GOOD + "warp: warp.yaml\n")
    assert issue.path == ("warp",) and "no warp file" in issue.message
    assert issue.line == line_of(GOOD + "warp: warp.yaml\n", "warp:")
    (issue,) = problems(tmp_path, "extends: base.yaml\nid: x\n")
    assert issue.path == ("extends",) and "no such spec file" in issue.message
    assert issue.line == 1
    (issue,) = problems(tmp_path, "extends: region.yaml\nid: x\n", name="x")
    assert "extends itself" in issue.message


def test_a_problem_inherited_through_extends_names_the_parent_file(tmp_path):
    base = write(tmp_path, edit("maxSlope: 3", "maxSlope: 7"), "base.yaml")
    (issue,) = problems(tmp_path, "extends: base.yaml\nid: walk\nname: Walk\n")
    assert issue.file == base and issue.line == line_of(GOOD, "maxSlope")
    # and one the child sets is reported in the child
    (issue,) = problems(tmp_path, "extends: base.yaml\nid: walk\nmaxSlope: 2.5\n")
    assert issue.file.name == "region.yaml" and issue.line == 3


def test_unknown_landmarks_are_suggested_from_the_registry(tmp_path):
    reg = tmp_path / "worlds" / "_landmarks"
    reg.mkdir(parents=True)
    (reg / "dam.yaml").write_text(
        yaml.safe_dump({"anchor": {"lon": 0, "lat": 0}, "depictions": {"generic": {"group": "x"}}})
    )
    text = GOOD + "  landmarks: [dma]\n"
    (issue,) = problems(tmp_path, text)
    assert issue.path == ("objects", "landmarks", 0) and "did you mean 'dam'?" in issue.message


def test_plugin_options_are_kept_but_typos_beside_them_are_not(tmp_path):
    ok = GOOD + "  typology:\n    facts: { plugin: datasf, rollYear: '2025' }\n    rules: []\n"
    assert [i for i in schema.validate(yaml.safe_load(ok)) if i.level == "error"] == []
    legacy = GOOD + "  typology:\n    facts: datasf\n    rollYear: '2025'\n    rules: []\n"
    assert [i for i in schema.validate(yaml.safe_load(legacy)) if i.level == "error"] == []
    typo = GOOD + "  typology:\n    facts: datasf\n    rulse: []\n"
    (issue,) = schema.validate(yaml.safe_load(typo))
    assert "did you mean 'rules'?" in issue.message


def test_null_unsets_an_optional_section_but_not_a_required_key():
    raw = yaml.safe_load(GOOD + "smoothing: null\nwarp: null\n")
    assert schema.validate(raw) == []
    raw = yaml.safe_load(GOOD.replace("style: desert-southwest", "style: null"))
    (issue,) = schema.validate(raw)
    assert issue.path == ("style",) and "missing" in issue.message


def test_files_that_are_not_region_specs_say_what_they_are():
    (issue,) = schema.validate({"background": 500, "focus": []})
    assert "warp file" in issue.message
    (issue,) = schema.validate({"anchor": {}, "depictions": {}})
    assert "landmark registry file" in issue.message


def test_a_huge_world_is_a_warning_not_an_error(tmp_path):
    big = edit("metersPerCell: 20", "metersPerCell: 0.5")
    _, issues = api.check(write(tmp_path, big))
    assert [i.level for i in issues] == ["warning"] and "million cells" in issues[0].message


def test_a_spec_given_as_a_dict_is_checked_too(tmp_path):
    raw = yaml.safe_load(GOOD) | {"maxSlope": 9}
    with pytest.raises(RegionError, match="maxSlope: must be 1–3, not 9"):
        load_region(raw, tmp_path)


def test_the_reference_in_docs_is_the_schemas():
    doc = (REPO / "docs" / "worlds.md").read_text()
    assert schema.BEGIN in doc and schema.END in doc
    assert schema.splice(doc, schema.reference()) == doc, (
        "docs/worlds.md's spec reference is out of date: "
        "cd pipeline && uv run pixelworld reference --write ../docs/worlds.md"
    )


def test_the_docs_example_specs_are_valid():
    """The specs docs/worlds.md and architecture.md §4 show check clean (warp files
    against the warp section)."""
    import re

    blocks = []
    for doc in ("worlds.md", "architecture.md"):
        text = (REPO / "docs" / doc).read_text()
        blocks += re.findall(r"```yaml\n(.*?)```", text, flags=re.S)
    specs = [yaml.safe_load(b) for b in blocks]
    regions = [s for s in specs if isinstance(s, dict) and "bounds" in s]
    warps = [s for s in specs if isinstance(s, dict) and "background" in s]
    assert len(regions) >= 2 and warps
    place = WORLDS / "example" / "region.yaml"  # as if in worlds/: its style packs and landmarks
    for raw in regions:
        assert schema.validate(raw, spec_path=place) == [], raw["id"]
    for raw in warps:
        ctx = schema.Ctx(None, None)
        schema.WARP.check(raw, ("warp",), ctx)
        assert ctx.issues == []


def test_the_reference_lists_every_key_with_its_default():
    ref = schema.reference()
    sections: list[tuple[str, schema.Map]] = []
    schema._sections(schema.REGION, "", sections)
    for path, m in sections:
        for k, key in m.keys.items():
            assert f"| `{k}` |" in ref, (path, k)
            assert key.doc.strip(), (path, k)
    assert "| `verticalExaggeration` | number, > 0 | 2.5 |" in ref
    assert "| `maxSlope` | integer, 1–3 | 2 |" in ref
