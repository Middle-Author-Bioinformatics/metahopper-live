import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { upgradeBinarenaView } from '../src/report-upgrade.ts';
import { isolatedReport } from '../src/frame.ts';

const oldReport = `<html><head></head><body>
<script type="application/json" id="science">{"total_bp":13720000,"bin":"Test"}</script>
<script>(function(){
var sub = Object.create(null), order = [], selected = new Set(), view = ['c1'];
var IDX = {c1:0,c2:1}; sub.c1='Manual bin'; order.push('Manual bin'); selected.add('c1');
function draw(){window.draws++;} function rebuild(){window.rebuilds++;}
window.addEventListener('resize', function(){ if (view.length) draw(); });
window.inspectManual=function(){return {sub:sub,order:order};};
})();</script></body></html>`;

test('older reports gain reversible contig selection without changing manual assignments or data', () => {
  const upgraded = upgradeBinarenaView(oldReport);
  assert(upgraded.includes('<script type="application/json" id="science">{"total_bp":13720000,"bin":"Test"}</script>'));
  const window: any = {draws:0,rebuilds:0,addEventListener() {}};
  vm.runInNewContext(upgraded.match(/<script>([\s\S]*?)<\/script>/)![1], {window});
  assert.deepEqual(Array.from(window.MHBinarenaView.capture()), ['c1']);
  window.MHBinarenaView.reset();
  assert.equal(window.MHBinarenaView.capture().length, 0);
  assert.equal(window.rebuilds, 1);
  window.MHBinarenaView.restore(['c1','c2','unknown']);
  assert.deepEqual(Array.from(window.MHBinarenaView.capture()), ['c1','c2']);
  assert.equal(window.draws, 1);
  assert.equal(window.inspectManual().sub.c1, 'Manual bin');
  assert.deepEqual(Array.from(window.inspectManual().order), ['Manual bin']);
});

test('selection compatibility is idempotent and only applies to the recognized report closure', () => {
  const upgraded = upgradeBinarenaView(oldReport);
  assert.equal(upgradeBinarenaView(upgraded), upgraded);
  for (const unknown of [oldReport.replace('var sub = Object.create(null)', 'var sub = {}'),
    oldReport.replace("window.addEventListener('resize', function(){ if (view.length) draw(); });", '')]) {
    assert.equal(upgradeBinarenaView(unknown), unknown);
  }
});

test('the signed viewer includes report navigation, cleanup, accessible hover and selection compatibility', () => {
  const html = isolatedReport(oldReport, 'report-controls-channel');
  assert(html.includes('window.MHBinarenaView = {'));
  assert(html.includes("bar.setAttribute('aria-label','Report navigation')"));
  assert(html.includes("point.addEventListener('focus'"));
  assert(html.includes('#bin-partition-note'));
  assert(html.includes("type:'reset-report-filters'"));
  assert(html.includes("type:'report-view-restored'"));
  assert.equal((html.match(/Content-Security-Policy/g) ?? []).length, 1);
});
