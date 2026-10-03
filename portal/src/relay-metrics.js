/** Ephemeral, identifier-free aggregates. No payload inspection or storage writes. */
export class RelayMetrics {
  constructor(enabled=false,emit=value=>console.log(JSON.stringify(value)),now=()=>Date.now()) {
    this.enabled=enabled;this.emit=emit;this.now=now;this.reset();
  }
  reset(){this.started=this.now();this.values={requests:0,completed:0,rejected:0,busy:0,responseBytes:0,maxResponseBytes:0,latencyMs:0,maxLatencyMs:0,maxPending:0,maxReading:0};}
  start(){if(this.enabled&&this.now()-this.started>=60000&&this.values.requests){this.emit({event:'relay_aggregate',windowMs:this.now()-this.started,...this.values});this.reset();}this.values.requests++;return this.now();}
  finish(start,status){this.values.completed++;if(status>=400)this.values.rejected++;if(status===429)this.values.busy++;const ms=Math.max(0,this.now()-start);this.values.latencyMs+=ms;this.values.maxLatencyMs=Math.max(this.values.maxLatencyMs,ms);}
  pressure(pending,reading){this.values.maxPending=Math.max(this.values.maxPending,pending);this.values.maxReading=Math.max(this.values.maxReading,reading);}
  response(bytes){this.values.responseBytes+=bytes;this.values.maxResponseBytes=Math.max(this.values.maxResponseBytes,bytes);}
}
