from .muse_minimax_director import (
    NODE_CLASS_MAPPINGS as _DIRECTOR_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _DIRECTOR_NODE_DISPLAY_NAME_MAPPINGS,
)
from .muse_minimax_refine import (
    NODE_CLASS_MAPPINGS as _REFINE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _REFINE_NODE_DISPLAY_NAME_MAPPINGS,
)
from .muse_model_route import (
    NODE_CLASS_MAPPINGS as _MODELROUTE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _MODELROUTE_NODE_DISPLAY_NAME_MAPPINGS,
)

# Bundled together in one repo/one installable package: the Director (scouting,
# chunking, continuity), its companion Refine node (second-pass hi-res fix on a
# chosen Seed Hunt candidate), and Muse Model Route — a tiny utility that routes
# one MODEL input to exactly one of two outputs based on a boolean, used in the
# example workflow to send either the Reference or First/Last-Frame model into
# the Director's single model input depending on mode. Three separate node
# classes, three separate keys in these mappings — nothing about how any of them
# works changes by living here instead of its own repo.
NODE_CLASS_MAPPINGS = {
    **_DIRECTOR_NODE_CLASS_MAPPINGS,
    **_REFINE_NODE_CLASS_MAPPINGS,
    **_MODELROUTE_NODE_CLASS_MAPPINGS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    **_DIRECTOR_NODE_DISPLAY_NAME_MAPPINGS,
    **_REFINE_NODE_DISPLAY_NAME_MAPPINGS,
    **_MODELROUTE_NODE_DISPLAY_NAME_MAPPINGS,
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
