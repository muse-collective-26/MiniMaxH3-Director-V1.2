// RunPod examples carry named values because older positional exports can drift.
import { app } from '../../scripts/app.js';
app.registerExtension({
  name: 'Muse.RunPod.NamedWidgets',
  beforeRegisterNodeDef(nodeType) {
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      if (data?.properties?.muse_runpod_named_widgets && data.widgets_values_named) {
        for (const widget of this.widgets || []) {
          if (Object.hasOwn(data.widgets_values_named, widget.name)) {
            widget.value = data.widgets_values_named[widget.name];
          }
        }
      }
      return configure?.apply(this, arguments);
    };
    const serialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (data) {
      const result = serialize?.apply(this, arguments);
      if (this.properties?.muse_runpod_named_widgets) {
        data.widgets_values_named = Object.fromEntries((this.widgets || [])
          .filter(w => w.options?.serialize !== false && w.type !== 'button')
          .map(w => [w.name, w.value]));
      }
      return result;
    };
  },
});
