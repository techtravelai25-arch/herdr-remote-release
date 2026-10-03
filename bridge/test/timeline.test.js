import test from 'node:test';
import assert from 'node:assert/strict';
import {Timeline} from '../src/timeline.js';
const pane=status=>({id:'p',kind:'codex',title:'Agent',status});
function setup(){let saved=[];let clock=Date.parse('2026-09-22T00:00:00Z');const store={read:()=>saved,write:(_,value)=>{saved=structuredClone(value);}};const tracker=new Timeline(store,{clock:()=>clock,limit:3,retention:10000});return {tracker,store,advance:n=>{clock+=n;}};}
test('timeline records observed transitions only, excludes output and ignores outage snapshots',()=>{
 const f=setup(),observe=(status,herdrOnline=true)=>f.tracker.observe({herdrOnline,panes:[{...pane(status),text:'secret prompt'}]});
 observe('working');assert.equal(f.tracker.list().events.length,0);f.advance(1000);observe('blocked');observe('blocked');observe('unknown',false);
 assert.equal(f.tracker.list().events.length,1);assert.equal(f.tracker.list().events[0].previousStatus,'working');assert.equal(JSON.stringify(f.tracker.list()).includes('secret'),false);
 f.advance(1000);observe('done');assert.equal(f.tracker.list().events[0].status,'done');
 const restored=new Timeline(f.store,{clock:()=>Date.parse('2026-09-22T00:00:05Z')});assert.equal(restored.list().events.length,2);
 assert.equal(restored.list().startedAt,'2026-09-22T00:00:01.000Z');
});
test('timeline bounds retention/count and restarts baseline after a pane disappears',()=>{
 const f=setup();for(const status of ['working','blocked','working','done','idle']){f.advance(100);f.tracker.observe({herdrOnline:true,panes:[pane(status)]});}
 assert.equal(f.tracker.list().events.length,3);f.tracker.observe({herdrOnline:true,panes:[]});f.tracker.observe({herdrOnline:true,panes:[pane('done')]});assert.equal(f.tracker.list().events.length,3);
 f.advance(11000);assert.equal(f.tracker.list().events.length,0);
});
test('timeline API stays within encrypted response budget with long Unicode titles',()=>{
 const store={read:()=>[],write:()=>{}},tracker=new Timeline(store);
 for(let i=0;i<600;i++)tracker.observe({herdrOnline:true,panes:[{id:'p',kind:'codex',title:'\u0001'.repeat(120),status:i%2?'working':'blocked'}]});
 const result=tracker.list();assert.ok(Buffer.byteLength(JSON.stringify(result))<66000);assert.equal(result.truncated,true);assert.ok(result.events.length>0);assert.equal(result.events[0].status,'working');
});
