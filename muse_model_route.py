class MuseModelRoute:
    """Reverse of a switch: one MODEL input plus a boolean routes to exactly one
    of two MODEL outputs, matching the true/false semantics of Lazy Switch KJ.
    The unselected output is None every run. Pairs with MuseMinimaxDirector's
    model/model_fl2va inputs — model_fl2va has always tolerated being empty;
    model only tolerates it because MuseMinimaxDirector's own sigma-shift step
    is now guarded to skip a None model instead of shifting it unconditionally.
    Wiring this into a node that still shifts model unconditionally will crash
    whenever switch selects the other output.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "switch": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("MODEL", "MODEL")
    RETURN_NAMES = ("on_true", "on_false")
    FUNCTION = "route"
    CATEGORY = "Muse Collective"

    def route(self, model, switch):
        return (model, None) if switch else (None, model)


NODE_CLASS_MAPPINGS = {
    "MuseModelRoute": MuseModelRoute,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MuseModelRoute": "Muse Model Route",
}
