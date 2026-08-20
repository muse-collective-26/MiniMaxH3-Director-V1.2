from .muse_minimax_director import (
    NODE_CLASS_MAPPINGS as _DIRECTOR_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _DIRECTOR_NODE_DISPLAY_NAME_MAPPINGS,
)
from .muse_minimax_refine import (
    NODE_CLASS_MAPPINGS as _REFINE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _REFINE_NODE_DISPLAY_NAME_MAPPINGS,
)

# Bundled together in one repo/one installable package: the Director (scouting,
# chunking, continuity) and its companion Refine node (second-pass hi-res fix on
# a chosen Seed Hunt candidate). Two separate node classes, two separate keys in
# these mappings — nothing about how either node works changes by living here
# instead of its own repo.
NODE_CLASS_MAPPINGS = {**_DIRECTOR_NODE_CLASS_MAPPINGS, **_REFINE_NODE_CLASS_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**_DIRECTOR_NODE_DISPLAY_NAME_MAPPINGS, **_REFINE_NODE_DISPLAY_NAME_MAPPINGS}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
