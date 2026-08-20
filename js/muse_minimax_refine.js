const { app } = window.comfyAPI.app;

// Muse Minimax Refine — candidate selector.
//
// The node itself takes four permanent candidate_N_images/candidate_N_audio socket
// pairs (wire up to four separate MuseMinimaxDirector renders, or a future Seed Hunt
// output) plus a plain "candidate" INT widget (1-4) that decides which one actually
// gets refined. This file just re-skins that INT widget as four clickable number
// buttons, so picking a candidate is "click 2, click Run" instead of typing a digit
// into a number field.

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;
  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4];
    w.draw = () => {};
  }
  if (w.element) w.element.style.display = "none";
}

function buildCandidateSelector(node, widget) {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "6px";
  wrap.style.padding = "4px 0";
  wrap.style.justifyContent = "center";

  const label = document.createElement("div");
  label.textContent = "Candidate";
  label.style.cssText = "color:#bbb;font-size:11px;display:flex;align-items:center;margin-right:4px;";
  wrap.appendChild(label);

  const buttons = [];
  const refresh = () => {
    buttons.forEach((b, i) => {
      const active = Number(widget.value) === i + 1;
      b.style.background = active ? "#4F8EF7" : "#2a2a2a";
      b.style.color = active ? "#fff" : "#ccc";
      b.style.borderColor = active ? "#4F8EF7" : "rgba(255,255,255,0.22)";
    });
  };

  for (let i = 1; i <= 4; i++) {
    const btn = document.createElement("button");
    btn.textContent = String(i);
    btn.type = "button";
    btn.style.cssText =
      "width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,0.22);" +
      "cursor:pointer;font-size:13px;font-weight:600;";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clicking the already-active candidate deselects it (back to 0/none) instead
      // of being a one-way switch — otherwise there was no way to reset the node to
      // its "not ready" state short of typing 0 into the hidden underlying widget.
      widget.value = Number(widget.value) === i ? 0 : i;
      if (widget.callback) widget.callback(widget.value);
      node.setDirtyCanvas(true, true);
      refresh();
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }

  refresh();
  return { container: wrap, refresh };
}

app.registerExtension({
  name: "Muse.MinimaxRefineV1_2",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "MuseMinimaxRefineV1_2") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

      const candidateWidget = (this.widgets || []).find((w) => w.name === "candidate");
      if (candidateWidget) {
        hideWidget(candidateWidget);
        const { container, refresh } = buildCandidateSelector(this, candidateWidget);
        this._museRefineRefresh = refresh;
        this.addDOMWidget("mmr_candidate_ui", "mmr_candidate_ui", container, {
          serialize: false,
          hideOnZoom: false,
        });
      }

      return r;
    };

    // onNodeCreated fires before ComfyUI applies a loaded workflow's saved
    // widgets_values onto the widgets, so the button highlight built there only
    // ever reflects the INPUT_TYPES default (0), never a real saved candidate value.
    // On a workflow saved with e.g. candidate=1 from an earlier run, that left the
    // buttons showing "nothing picked" while the node would actually still run with
    // candidate=1 underneath — exactly the silent-mismatch bug this fixes. onConfigure
    // fires after the real widgets_values is applied, so re-running refresh() there
    // is what makes the display match what will actually execute.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      if (this._museRefineRefresh) this._museRefineRefresh();
      return r;
    };
  },
});
