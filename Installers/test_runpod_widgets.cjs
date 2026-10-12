const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
let extension;
const source = fs.readFileSync(path.join(__dirname, '../js/muse_runpod_workflow.js'), 'utf8')
  .replace(/^import .*;$/m, '');
vm.runInNewContext(source, {app: {registerExtension: x => extension = x}});
function Node() {
  this.widgets = [{name: 'timeline_data', value: 'wrong'}, {name: 'models_to_load', value: 4}];
  this.properties = {muse_runpod_named_widgets: true};
}
Node.prototype.onConfigure = function () { this.editorTimeline = this.widgets[0].value; };
extension.beforeRegisterNodeDef(Node);
const node = new Node();
node.onConfigure({properties: node.properties, widgets_values_named: {
  timeline_data: '{"analyze_base_url":"http://127.0.0.1:11435"}', models_to_load: 'Both / Mixed'
}});
assert.equal(JSON.parse(node.editorTimeline).analyze_base_url, 'http://127.0.0.1:11435');
assert.equal(node.widgets[1].value, 'Both / Mixed');
node.widgets[1].value = 'Reference only';
const saved = {};
node.onSerialize(saved);
assert.equal(saved.widgets_values_named.models_to_load, 'Reference only');
const ordinary = new Node();
ordinary.properties = {};
ordinary.onConfigure({properties: {}, widgets_values_named: {models_to_load: 'Both / Mixed'}});
assert.equal(ordinary.widgets[1].value, 4);
console.log('RunPod widget restore/save and non-RunPod isolation passed.');
