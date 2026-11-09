"""Pixelworld geo pipeline: open data in, gridded world packages out.

The command line (`pixelworld build worlds/sf/walk.yaml`) and the Python API
do the same thing:

    import pixelworld_pipeline

    report = pixelworld_pipeline.build("worlds/sf/walk.yaml", out_dir="out/sf-walk")
    report = pixelworld_pipeline.build(spec_dict, base_dir="worlds/sf")

Region-specific data comes from plugins (facts sources, source adapters),
found through entry points: see pixelworld_pipeline.plugins and docs/plugins.md.
"""

# The stage module `pixelworld_pipeline.build` is imported first, so that the
# API function below keeps the package's `build` attribute: importing a
# submodule binds its name on the package only when it first loads.
# `from pixelworld_pipeline.build import ...` still reaches the module.
from . import build as _build_module  # noqa: F401
from .api import build, default_out_dir, load_region

__all__ = ["build", "default_out_dir", "load_region"]
