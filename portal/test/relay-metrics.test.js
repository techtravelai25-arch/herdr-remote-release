import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RelayMetrics} from '../src/relay-metrics.js';
test('relay telemetry is sparse numeric metadata and disabled by default',()=>{
 let now=0;const logs=[];const metrics=new RelayMetrics(true,x=>logs.push(x),()=>now);
 const start=metrics.start();metrics.pressure(2,3);metrics.response(120);now=20;metrics.finish(start,200);
 assert.equal(logs.length,0);now=60000;metrics.start();
 assert.deepEqual(logs,[{event:'relay_aggregate',windowMs:60000,requests:1,completed:1,rejected:0,busy:0,responseBytes:120,maxResponseBytes:120,latencyMs:20,maxLatencyMs:20,maxPending:2,maxReading:3}]);
 const disabled=new RelayMetrics(false,()=>assert.fail('logging disabled'),()=>now);disabled.start();now+=60001;disabled.start();
});
